// A local site with known performance defects and their corrected twin, for
// the performance.web tests. Every delay is set here, so a test can assert
// that a slow page measures slower than its fast twin by a wide margin
// without depending on exact milliseconds.
//
// The page at / is `slow` or `fast` depending on `mode`, so two runs of the
// same suite (same suite hash) can be compared before and after a "fix".
//
// slow: a parser-blocking script answers after 700 ms, so nothing paints
// before it (late FCP and LCP); a promotion banner is inserted above the
// content 100 ms after parsing (a layout shift, before the journey's ready
// assertion, which waits for the banner, so before any input); a 150 ms task
// blocks the main thread after load; the Apply handler busy-waits 250 ms.
// fast: the same page with no blocking script, the banner in place from the
// start, no long task and an instant handler.
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

export const SLOW = {
  scriptDelayMs: 700,
  loadTaskMs: 150,
  handlerMs: 250,
};

const busy = (ms: number) =>
  `var t=performance.now();while(performance.now()-t<${ms}){}`;

const BANNER =
  "<div id=\"promo\" data-testid=\"promo\" style=\"height:220px;background:#fde68a\">Promotion</div>";

function page(mode: 'slow' | 'fast'): string {
  const slow = mode === 'slow';
  const main = `<main><h1 id="hero" style="font-size:64px;line-height:1.1">Quarterly billing overview for every team</h1><p>Invoices, usage and payment methods for the workspace, updated daily.</p><p>Review the plan below, then apply the changes.</p><button id="apply" style="height:44px;min-width:120px">Apply</button><p id="status" data-testid="status">Pending</p></main>`;
  const script = slow
    ? `setTimeout(function(){document.body.insertAdjacentHTML('afterbegin',${JSON.stringify(BANNER)});},100);
window.addEventListener('load',function(){setTimeout(function(){${busy(SLOW.loadTaskMs)}},10);});
document.getElementById('apply').addEventListener('click',function(){${busy(SLOW.handlerMs)}document.getElementById('status').textContent='Applied';});`
    : `document.getElementById('apply').addEventListener('click',function(){document.getElementById('status').textContent='Applied';});`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Billing</title><style>body{margin:0;font:16px sans-serif}main{padding:24px}p{max-width:640px}</style></head><body>${slow ? '<script src="/slow.js"></script>' : BANNER}${main}<script>${script}</script></body></html>`;
}

// Fixed CPU work (not wall-clock), so a CPU slowdown makes it longer.
function work(iterations: number): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Work</title></head><body><div data-testid="promo">Promotion</div><main><h1>Report</h1><p>Computed figures.</p><button id="apply">Apply</button><p id="status" data-testid="status">Pending</p></main><script>window.addEventListener('load',function(){setTimeout(function(){var x=0;for(var i=0;i<${iterations};i++){x+=Math.sqrt(i)}window.__x=x;},0)});document.getElementById('apply').addEventListener('click',function(){document.getElementById('status').textContent='Applied';});</script></body></html>`;
}

export async function performanceSite() {
  const state = { mode: 'slow' as 'slow' | 'fast', requests: [] as string[] };
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://local');
    state.requests.push(url.pathname);
    if (url.pathname === '/slow.js') {
      setTimeout(() => {
        response.setHeader('content-type', 'text/javascript');
        response.end('window.__slow = true;');
      }, SLOW.scriptDelayMs);
      return;
    }
    // Never answers: the document's load event never fires.
    if (url.pathname === '/hang.png') return;
    response.setHeader('content-type', 'text/html; charset=utf-8');
    if (url.pathname === '/work')
      return response.end(work(Number(url.searchParams.get('n') ?? 0)));
    if (url.pathname === '/hanging')
      return response.end(
        '<!doctype html><html lang="en"><head><title>Hanging</title></head><body><div data-testid="promo">Promotion</div><main><h1>Waiting</h1><button id="apply">Apply</button><p data-testid="status">Pending</p></main><img src="/hang.png" alt="" width="10" height="10"></body></html>',
      );
    response.end(page(state.mode));
  });
  await new Promise<void>((resolve) =>
    server.listen(0, '127.0.0.1', () => resolve()),
  );
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    state,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
