// A local fixture application for state coverage, used by
// examples/states.json, examples/states-demo.ts and test/state-examples.test.ts.
// Plain HTML and a little script, no framework, no network writes: form
// validation, loading/empty/error/success list states, a dialog, a menu, a
// paginated table and a multi-step flow. `?defect=1` on a page turns on a
// deliberate defect (named per page below) so a suite's state checks can be
// seen failing. Product vocabulary lives here, never in the engine.
import { createServer, type Server } from 'node:http';
import type { Action, Choice, Journey } from '../src/contracts.js';
import type { Models } from '../src/models.js';

const style = `<style>body{font:18px system-ui;max-width:860px;margin:40px auto;padding:0 20px;color:#1d2533;background:#f4f6f9}main{background:white;border-radius:12px;padding:24px}button,a,input{font:inherit;margin:6px 0;padding:6px 10px}[role=alert]{color:#9b1c1c}[hidden]{display:none!important}table{border-collapse:collapse}td,th{border:1px solid #ccc;padding:4px 8px}[role=dialog]{position:fixed;inset:120px 20%;background:white;border:2px solid #333;border-radius:12px;padding:24px}[role=menu]{list-style:none;padding:4px;border:1px solid #999;width:200px}[role=menuitem]{display:block;width:100%;text-align:left}</style>`;
const page = (title: string, body: string, script = '') =>
  `<!doctype html><html lang="en"><meta charset="utf-8"><title>${title}</title>${style}<h1>${title}</h1><main>${body}</main><script>${script}</script></html>`;

const ITEMS = Array.from({ length: 25 }, (_, index) => `Item ${index + 1}`);
const PAGE_SIZE = 10;

function render(url: URL): string | null {
  const defect = url.searchParams.get('defect') === '1';
  switch (url.pathname) {
    case '/':
      return page(
        'State fixture',
        '<ul><li><a href="/form">Sign-up form</a></li><li><a href="/items?mode=error">Items (error)</a></li><li><a href="/items?mode=empty">Items (empty)</a></li><li><a href="/dialog">Profile dialog</a></li><li><a href="/menu">Actions menu</a></li><li><a href="/table?page=1">Item table</a></li><li><a href="/wizard/1">Setup wizard</a></li></ul>',
      );
    // Validation: errors are announced in an alert, the field is marked
    // invalid and focused. Defect: the error is shown without the alert role.
    case '/form':
      return page(
        'Sign-up form',
        `<form novalidate><label>Email <input id="email" type="email" autocomplete="off"></label><p id="email-error" ${defect ? '' : 'role="alert"'} data-testid="email-error" hidden>Enter a valid email address</p><button type="button" id="create">Create account</button></form><p data-testid="created" hidden>Account created</p>`,
        `document.getElementById('create').addEventListener('click', () => {
          const email = document.getElementById('email');
          const error = document.getElementById('email-error');
          const valid = /^[^@\\s]+@[^@\\s]+\\.[a-z]+$/i.test(email.value);
          error.hidden = valid;
          email.setAttribute('aria-invalid', String(!valid));
          if (valid) { email.removeAttribute('aria-describedby'); document.querySelector('[data-testid=created]').hidden = false; }
          else { email.setAttribute('aria-describedby', 'email-error'); email.focus(); }
        });`,
      );
    // Loading, then empty, error or success. Retry reloads into success.
    // Defect: the empty state has no way to create an item (the error and
    // retry path has none).
    case '/items': {
      const mode = url.searchParams.get('mode') ?? 'success';
      return page(
        'Items',
        `<p role="status" aria-busy="true" data-testid="loading">Loading items…</p>
         <div data-testid="empty" hidden><p>No items yet</p>${defect ? '' : '<button type="button" id="create">Create item</button>'}</div>
         <div data-testid="error" hidden><p role="alert">Could not load items</p><button type="button" id="retry">Retry</button></div>
         <table data-testid="items" hidden><thead><tr><th>Name</th></tr></thead><tbody>${ITEMS.slice(0, 3)
           .map((item) => `<tr><td>${item}</td></tr>`)
           .join('')}</tbody></table>`,
        `const show = (state) => {
          const loading = document.querySelector('[data-testid=loading]');
          loading.hidden = state !== 'loading';
          loading.setAttribute('aria-busy', String(state === 'loading'));
          for (const name of ['empty', 'error', 'items'])
            document.querySelector('[data-testid=' + name + ']').hidden = state !== name;
        };
        const load = (result) => { show('loading'); setTimeout(() => show(result), 1000); };
        document.getElementById('retry').addEventListener('click', () => load('items'));
        load(${JSON.stringify(mode === 'success' ? 'items' : mode)});`,
      );
    }
    // A modal dialog that takes focus and returns it. Defect: the dialog
    // opens without moving focus into it.
    case '/dialog':
      return page(
        'Profile',
        `<p data-testid="profile-name">Name: Ada</p><button type="button" id="edit">Edit profile</button>
         <div role="dialog" aria-modal="true" aria-labelledby="dialog-title" id="dialog" hidden><h2 id="dialog-title">Edit profile</h2><label>Display name <input id="display-name" value="Ada"></label><button type="button" id="save">Save profile</button><button type="button" id="cancel">Cancel</button></div>`,
        `const dialog = document.getElementById('dialog');
        const edit = document.getElementById('edit');
        const close = (saved) => { dialog.hidden = true; if (saved) document.querySelector('[data-testid=profile-name]').textContent = 'Name: ' + document.getElementById('display-name').value; edit.focus(); };
        edit.addEventListener('click', () => { dialog.hidden = false; ${defect ? '' : "document.getElementById('display-name').focus();"} });
        document.getElementById('save').addEventListener('click', () => close(true));
        document.getElementById('cancel').addEventListener('click', () => close(false));
        dialog.addEventListener('keydown', (event) => { if (event.key === 'Escape') close(false); });`,
      );
    // A menu button. Defect: aria-expanded is never updated.
    case '/menu':
      return page(
        'Actions',
        `<button type="button" id="actions" aria-haspopup="menu" aria-expanded="false" aria-controls="menu">Actions</button>
         <ul role="menu" id="menu" aria-label="Actions" hidden><li role="none"><button role="menuitem" type="button">Rename</button></li><li role="none"><button role="menuitem" type="button" id="archive">Archive</button></li></ul>
         <p data-testid="menu-status">Active</p>`,
        `const button = document.getElementById('actions');
        const menu = document.getElementById('menu');
        const toggle = (open) => { menu.hidden = !open; ${defect ? '' : "button.setAttribute('aria-expanded', String(open));"} };
        button.addEventListener('click', () => toggle(menu.hidden));
        document.getElementById('archive').addEventListener('click', () => { document.querySelector('[data-testid=menu-status]').textContent = 'Archived'; toggle(false); button.focus(); });
        menu.addEventListener('keydown', (event) => { if (event.key === 'Escape') { toggle(false); button.focus(); } });`,
      );
    // Pagination with links. Defect: the last page still offers Next page.
    case '/table': {
      const pages = Math.ceil(ITEMS.length / PAGE_SIZE);
      const current = Math.min(
        pages,
        Math.max(1, Number(url.searchParams.get('page')) || 1),
      );
      const keep = defect ? '&defect=1' : '';
      const rows = ITEMS.slice((current - 1) * PAGE_SIZE, current * PAGE_SIZE);
      const first = (current - 1) * PAGE_SIZE + 1;
      return page(
        'Item table',
        `<p data-testid="range">Showing ${first}–${first + rows.length - 1} of ${ITEMS.length}</p>
         <table data-testid="table"><thead><tr><th>Name</th></tr></thead><tbody>${rows.map((item) => `<tr><td>${item}</td></tr>`).join('')}</tbody></table>
         <nav aria-label="Pagination">${current > 1 ? `<a href="/table?page=${current - 1}${keep}">Previous page</a> ` : ''}<span aria-current="page">Page ${current} of ${pages}</span>${current < pages || defect ? ` <a href="/table?page=${Math.min(pages, current + 1)}${keep}">Next page</a>` : ''}</nav>`,
      );
    }
    // Three steps and a summary. Continue stays disabled until the step's
    // field is filled. Defect: step 2 has no way back.
    case '/wizard/1':
    case '/wizard/2':
    case '/wizard/3': {
      const step = Number(url.pathname.at(-1));
      const field = ['Workspace name', 'Team size', 'Region'][step - 1]!;
      const next =
        (step === 3 ? '/wizard/done' : `/wizard/${step + 1}`) +
        (defect ? '?defect=1' : '');
      return page(
        'Setup wizard',
        `<p data-testid="progress" aria-current="step">Step ${step} of 3</p>
         <label>${field} <input id="field" autocomplete="off"></label>
         <a id="continue" data-href="${next}" aria-disabled="true">Continue</a>
         ${step > 1 && !(defect && step === 2) ? `<a href="/wizard/${step - 1}${defect ? '?defect=1' : ''}">Back</a>` : ''}`,
        `const field = document.getElementById('field');
        const next = document.getElementById('continue');
        field.addEventListener('input', () => {
          if (field.value.trim()) { next.setAttribute('href', next.dataset.href); next.removeAttribute('aria-disabled'); }
          else { next.removeAttribute('href'); next.setAttribute('aria-disabled', 'true'); }
        });`,
      );
    }
    case '/wizard/done':
      return page(
        'Setup wizard',
        '<p data-testid="progress">All set</p><a href="/">Back to start</a>',
      );
  }
  return null;
}

export type StateFixture = {
  url: string;
  close(): Promise<void>;
};

export async function stateFixture(): Promise<StateFixture> {
  const server: Server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://fixture');
    // Read-only: the fixture accepts no writes.
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      response.statusCode = 405;
      response.end();
      return;
    }
    const html = render(url);
    response.statusCode = html ? 200 : 404;
    response.setHeader('Content-Type', 'text/html; charset=utf-8');
    response.end(html ?? page('Not found', '<p>Not found</p>'));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string')
    throw new Error('State fixture failed to bind');
  return {
    url: `http://127.0.0.1:${address.port}`,
    async close() {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}

// Deterministic decisions for the example suites: each journey has an
// ordered script of action descriptions (a key press matches its description
// without the focus note, e.g. "Press Tab"). The next scripted action is
// chosen as soon as it is offered; until then the agent waits (loading
// states). Progress is read from the journey history, so an action the runner
// asked to re-plan instead of dispatching is chosen again. No model is
// called: these runs verify the harness and the fixture, not a model.
export function scriptedDecisions(scripts: Record<string, string[]>): Models {
  const choice = (actions: Action[], id: string): Choice => ({
    type: 'choice',
    choice: id,
    confidence: 1,
    probabilities: Object.fromEntries([
      ...actions.map((action) => [action.id, action.id === id ? 1 : 0]),
      ['no_match', id === 'no_match' ? 1 : 0],
    ]),
  });
  const shown = (action: Action, snapshot: string) => {
    const target = 'target' in action ? action.target : undefined;
    return (
      !(target?.by === 'role' && target.name) || snapshot.includes(target.name)
    );
  };
  const matches = (action: Action, wanted: string | undefined) =>
    wanted !== undefined &&
    (action.description === wanted ||
      (action.kind === 'key' && action.description.startsWith(`${wanted} (`)));
  return {
    async plan(journey: Journey) {
      return {
        objective: `Follow the reviewed script for ${journey.id}`,
        concerns: [],
      };
    },
    async choose(journey, observation, _plan, actions, history) {
      const script = scripts[journey.id] ?? [];
      const done = history.filter(
        (entry) => !entry.error && !/^Wait\b/.test(entry.action),
      ).length;
      // Candidates are read from the live page after the observation, so a
      // control can be offered that the observed state did not show yet (the
      // error panel replacing the loading one in between). Acting on it would
      // skip a state the journey declares, so a role/name target is chosen
      // only once the observation shows it.
      const next = actions.find(
        (action) =>
          matches(action, script[done]) && shown(action, observation.snapshot),
      );
      if (next) return choice(actions, next.id);
      const wait = actions.find((action) => action.kind === 'wait');
      return choice(actions, wait?.id ?? 'no_match');
    },
  };
}

// The scripts for examples/states.json, examples/keyboard.json and
// examples/notes.json, by journey id.
export const STATE_SCRIPTS: Record<string, string[]> = {
  'form-validation': [
    'Enter an invalid email',
    'Create the account',
    'Enter a valid email',
    'Create the account',
  ],
  'items-error-retry': ['Retry loading the items'],
  'items-empty': [],
  'dialog-edit': ['Open the profile dialog', 'Change the display name', 'Save the profile'],
  'menu-archive': ['Open the actions menu', 'Click menuitem Archive'],
  'table-pagination': ['Open Next page', 'Open Next page'],
  'save-note': ['Write the note', 'Save the note'],
  'dialog-keyboard': [
    'Press Tab',
    'Press Enter',
    'Change the display name',
    'Press Tab',
    'Press Enter',
  ],
  'wizard-steps': [
    'Name the workspace',
    'Open Continue',
    'Enter the team size',
    'Open Continue',
    'Choose the region',
    'Open Continue',
  ],
};
