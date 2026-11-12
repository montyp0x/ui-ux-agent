// Local pages for the visual.baseline tests and threshold calibration. Each
// page renders the features that make screenshots unstable in practice:
// gradients, shadows, rounded corners, SVG, a raster image, a focused text
// field, a CSS transition and an infinite animation. `variant` seeds one
// meaningful change at a time.
import { PNG } from 'pngjs';

// A 24x24 raster image with a colour ramp, as a data URI.
function rampImage(): string {
  const png = new PNG({ width: 24, height: 24 });
  for (let y = 0; y < 24; y++)
    for (let x = 0; x < 24; x++) {
      const index = (y * 24 + x) * 4;
      png.data[index] = x * 10;
      png.data[index + 1] = y * 10;
      png.data[index + 2] = 160;
      png.data[index + 3] = 255;
    }
  return `data:image/png;base64,${PNG.sync.write(png).toString('base64')}`;
}
const RAMP = rampImage();

export type ArticleVariant = {
  // The primary button's label (seeded change: one word).
  button?: string;
  // Extra left offset of the card in px (seeded change: a small move).
  shift?: number;
  // The card's accent colour (seeded change: a colour).
  accent?: string;
  // Server time shown in the masked #clock element.
  clock?: string;
  // A secret token printed on the page.
  token?: string;
};

const CSS = `*{box-sizing:border-box}body{margin:0;font:16px/1.5 system-ui,sans-serif;color:#18223a;background:#f4f5f7}
main{padding:32px;max-width:760px}
.card{position:relative;border-radius:14px;padding:24px;background:linear-gradient(135deg,#fff,#e8eefb);box-shadow:0 6px 24px rgba(20,40,90,.18)}
.accent{height:6px;border-radius:3px;margin-bottom:16px}
button{font:inherit;padding:10px 20px;border:0;border-radius:8px;background:#2255ac;color:#fff;transition:background .6s ease}
button:hover{background:#163a77}
input{font:inherit;padding:8px;border:1px solid #9aa5b8;border-radius:6px;width:260px}
.spinner{width:28px;height:28px;border:4px solid #c8d2e6;border-top-color:#2255ac;border-radius:50%;animation:spin 1s linear infinite;display:inline-block;vertical-align:middle}
@keyframes spin{to{transform:rotate(360deg)}}
.fade{animation:fade 3s ease-in forwards}@keyframes fade{from{opacity:0}to{opacity:1}}
footer{margin-top:16px;color:#596574}#clock{font-variant-numeric:tabular-nums}`;

export function article(variant: ArticleVariant = {}): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Billing</title><style>${CSS}</style></head><body><main>
<h1>Billing settings</h1>
<div class="card" style="left:${variant.shift ?? 0}px">
<div class="accent" style="background:${variant.accent ?? '#2a9d6f'}"></div>
<p class="fade">Invoices are sent on the first working day of each month to the address below.</p>
<p><img src="${RAMP}" width="24" height="24" alt="Ramp"> <svg width="24" height="24" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="10" fill="none" stroke="#2255ac" stroke-width="2"/><path d="M7 12l3 3 7-7" fill="none" stroke="#2a9d6f" stroke-width="2"/></svg> Verified</p>
<label for="email">Invoice email</label><br><input id="email" value="billing@example.test" autofocus>
<p><button type="button">${variant.button ?? 'Save changes'}</button> <span class="spinner" role="status" aria-label="Loading"></span></p>
${variant.token ? `<p>API token <code id="token">${variant.token}</code></p>` : ''}
</div>
<footer>Last synced <time id="clock">${variant.clock ?? '12:00:00'}</time> · <a href="/done">Continue</a></footer>
</main></body></html>`;
}

// A page whose script rewrites a counter every 30 ms: never two identical
// captures unless the counter is masked.
export function ticker(): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Live</title><style>${CSS}</style></head><body><main><h1>Live status</h1><p>Requests: <span id="count" style="display:inline-block;width:8em">0</span></p><footer><a href="/done">Continue</a></footer></main><script>const count=document.getElementById('count');const tick=()=>{count.textContent=performance.now().toFixed(1);requestAnimationFrame(tick)};tick()</script></body></html>`;
}

export function done(clock = '12:00:00'): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Done</title><style>${CSS}</style></head><body><main><h1>Saved</h1><p>Your billing settings are saved.</p><footer>At <time id="clock">${clock}</time></footer></main></body></html>`;
}
