// A local write-flow fixture with a data lifecycle service, for
// examples/notes.json and test/data-lifecycle.test.ts. The app stores notes
// per owner; /__fixture/* is the isolated fixture service the runner's
// dataLifecycle hooks call: reset, setup (creates a disposable owner for the
// run and returns it as {{data.owner}}), cleanup and verify. Faults can be
// switched on to exercise failed cleanups. In-memory only.
import { createServer, type IncomingMessage } from 'node:http';

export type NotesFaults = {
  // Cleanup answers HTTP 500.
  cleanupError?: boolean;
  // Cleanup answers 204 but deletes nothing (verify then reports records).
  cleanupLeavesData?: boolean;
  // Setup answers HTTP 500.
  setupError?: boolean;
  // Saving a note takes this long (ms).
  slowSave?: number;
};

async function json(request: IncomingMessage): Promise<Record<string, string>> {
  let data = '';
  for await (const chunk of request) data += String(chunk);
  return data ? (JSON.parse(data) as Record<string, string>) : {};
}

const ownerOf = (run: string) => `owner-${run.toLowerCase()}`;

export async function notesFixture(faults: NotesFaults = {}) {
  const notes = new Map<string, string[]>();
  const owners = new Set<string>();
  // Hook calls, for tests: [path, run, trigger].
  const calls: { hook: string; run?: string; trigger?: string }[] = [];
  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? '/', 'http://fixture');
    const method = request.method ?? 'GET';
    if (url.pathname.startsWith('/__fixture/')) {
      const hook = url.pathname.slice('/__fixture/'.length);
      const body = method === 'GET' ? {} : await json(request);
      const run = body.run ?? url.searchParams.get('run') ?? undefined;
      calls.push({ hook, run, trigger: body.trigger });
      if (hook === 'reset' && method === 'POST') {
        notes.clear();
        owners.clear();
        response.statusCode = 204;
        response.end();
      } else if (hook === 'setup' && method === 'POST' && run) {
        if (faults.setupError) {
          response.statusCode = 500;
          response.end();
          return;
        }
        owners.add(ownerOf(run));
        response.setHeader('Content-Type', 'application/json');
        response.end(JSON.stringify({ values: { owner: ownerOf(run) } }));
      } else if (hook === 'cleanup' && method === 'POST' && run) {
        if (faults.cleanupError) {
          response.statusCode = 500;
          response.end();
          return;
        }
        if (!faults.cleanupLeavesData) {
          notes.delete(ownerOf(run));
          owners.delete(ownerOf(run));
        }
        response.statusCode = 204;
        response.end();
      } else if (hook === 'verify' && method === 'GET' && run) {
        const owner = ownerOf(run);
        response.setHeader('Content-Type', 'application/json');
        response.end(
          JSON.stringify({
            remaining: (notes.get(owner)?.length ?? 0) + (owners.has(owner) ? 1 : 0),
          }),
        );
      } else {
        response.statusCode = 404;
        response.end();
      }
      return;
    }
    if (url.pathname === '/api/notes' && method === 'POST') {
      const { owner, text } = await json(request);
      if (!owner || !owners.has(owner) || !text) {
        response.statusCode = 400;
        response.end();
        return;
      }
      if (faults.slowSave)
        await new Promise((resolve) => setTimeout(resolve, faults.slowSave));
      notes.set(owner, [...(notes.get(owner) ?? []), text]);
      response.setHeader('Content-Type', 'application/json');
      response.end(JSON.stringify({ notes: notes.get(owner) }));
      return;
    }
    if (url.pathname === '/notes' && method === 'GET') {
      const owner = url.searchParams.get('owner') ?? '';
      const list = (notes.get(owner) ?? [])
        .map((note) => `<li>${note.replace(/[<&]/g, '')}</li>`)
        .join('');
      response.setHeader('Content-Type', 'text/html; charset=utf-8');
      response.end(`<!doctype html><html lang="en"><title>Notes</title><h1>Notes</h1>
<main><p>Signed in as <span data-testid="owner"></span></p><label>Note <input id="note" autocomplete="off"></label>
<button type="button" id="save">Save note</button><ul data-testid="notes">${list}</ul></main>
<script>
const owner = new URLSearchParams(location.search).get('owner');
document.querySelector('[data-testid=owner]').textContent = owner;
document.getElementById('save').addEventListener('click', async () => {
  const text = document.getElementById('note').value;
  const response = await fetch('/api/notes', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ owner, text }) });
  if (!response.ok) return;
  const { notes } = await response.json();
  const list = document.querySelector('[data-testid=notes]');
  list.replaceChildren(...notes.map((note) => Object.assign(document.createElement('li'), { textContent: note })));
});
</script></html>`);
      return;
    }
    response.statusCode = 404;
    response.end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string')
    throw new Error('Notes fixture failed to bind');
  return {
    url: `http://127.0.0.1:${address.port}`,
    calls,
    faults,
    // Everything the fixture still stores, across all runs.
    stored: () => ({
      owners: [...owners],
      notes: [...notes.values()].reduce((sum, list) => sum + list.length, 0),
    }),
    async close() {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}
