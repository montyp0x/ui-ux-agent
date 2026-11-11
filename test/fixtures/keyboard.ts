// A local keyboard fixture: a page with a well-behaved modal dialog (initial
// focus, focus trap, Escape, focus restoration), a broken one, a control
// without a focus indicator, an off-screen focus target and a control only a
// pointer can operate. Pointer events in the page are reported to the server,
// so a test can prove a keyboard-only journey never used the pointer. Used by
// test/keyboard.test.ts; no application vocabulary is built into the engine.
import { createServer } from 'node:http';

export const KEYBOARD_PAGE = `<!doctype html><html lang="en"><meta charset="utf-8"><title>Keyboard fixture</title>
<style>
body{font:18px system-ui;margin:40px}
button,a{font:inherit;margin:6px;padding:6px 10px}
.silent:focus{outline:none}
.offscreen{position:absolute;left:-9999px}
[role=dialog]{position:fixed;inset:80px;background:white;border:2px solid #333;padding:24px}
[hidden]{display:none!important}
.pointer-only{display:inline-block;padding:8px;border:1px dashed #555;cursor:pointer}
</style>
<h1>Keyboard fixture</h1>
<main>
<a href="/docs" id="docs">Docs</a>
<label>Name <input id="name"></label>
<button id="open-good" type="button">Open settings</button>
<button id="open-bad" type="button">Open broken dialog</button>
<button class="silent" type="button">Silent button</button>
<a class="offscreen" href="/hidden">Hidden link</a>
<div class="pointer-only" id="pointer-only">Pointer only</div>
<p data-testid="status">Idle</p>
</main>
<div role="dialog" aria-modal="true" aria-labelledby="good-title" id="good" hidden>
<h2 id="good-title">Settings</h2>
<button id="save" type="button">Save settings</button>
<button id="close-good" type="button">Close settings</button>
</div>
<div role="dialog" aria-modal="true" aria-labelledby="bad-title" id="bad" hidden>
<h2 id="bad-title">Broken dialog</h2>
<button id="close-bad" type="button">Close broken dialog</button>
</div>
<script>
const $ = (id) => document.getElementById(id);
const status = (text) => { document.querySelector('[data-testid=status]').textContent = text; };
let opener = null;
const good = $('good');
function openGood() { opener = document.activeElement; good.hidden = false; $('save').focus(); status('Settings open'); }
function closeGood(text) { good.hidden = true; status(text || 'Settings closed'); opener && opener.focus(); }
$('open-good').addEventListener('click', openGood);
$('close-good').addEventListener('click', () => closeGood());
$('save').addEventListener('click', () => closeGood('Saved'));
good.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') { event.preventDefault(); closeGood(); return; }
  if (event.key !== 'Tab') return;
  const items = [$('save'), $('close-good')];
  const index = items.indexOf(document.activeElement);
  event.preventDefault();
  items[(index + (event.shiftKey ? items.length - 1 : 1)) % items.length].focus();
});
// The broken dialog: no initial focus, no trap, no Escape, no restoration.
$('open-bad').addEventListener('click', () => { $('bad').hidden = false; status('Broken open'); });
$('close-bad').addEventListener('click', () => { $('bad').hidden = true; status('Broken closed'); });
$('pointer-only').addEventListener('click', () => { status('Pointer used'); });
for (const type of ['pointerdown', 'pointermove', 'mousedown', 'mousemove', 'wheel', 'touchstart'])
  addEventListener(type, () => { fetch('/__pointer?type=' + type); }, { capture: true, passive: true });
</script></html>`;

export async function keyboardFixture() {
  const pointer: string[] = [];
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://fixture');
    if (url.pathname === '/__pointer') {
      pointer.push(url.searchParams.get('type') ?? 'unknown');
      response.end('ok');
      return;
    }
    response.setHeader('Content-Type', 'text/html');
    if (url.pathname === '/docs') {
      response.end(
        '<!doctype html><html lang="en"><title>Docs</title><h1>Docs</h1><a href="/">Home</a></html>',
      );
      return;
    }
    response.end(KEYBOARD_PAGE);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string')
    throw new Error('Missing fixture port');
  return {
    url: `http://127.0.0.1:${address.port}`,
    pointer,
    async close() {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}
