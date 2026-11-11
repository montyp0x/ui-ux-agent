// Local pages with layout defects seeded at narrow widths (<= 480px) and their
// corrected twins. Each fixture pairs `defect` with `corrected`: the same page
// except for the CSS that causes the defect.
const BASE =
  '*{box-sizing:border-box}body{margin:0;font:16px/1.4 sans-serif;color:#18223a}button,input{font:inherit}';

function page(title: string, css: string, body: string): string {
  return `<!doctype html><html lang="en"><head><meta name="viewport" content="width=device-width"><title>${title}</title><style>${BASE}${css}</style></head><body>${body}</body></html>`;
}

// A field label in a fixed-width, no-wrap, overflow-hidden box at mobile widths.
const labelForm = `<main style="padding:24px;max-width:480px"><form><div class="field"><label class="field-label" for="email">Email address for invoices</label><input id="email" style="width:100%;height:40px"></div><button type="submit" style="margin-top:16px;height:44px;min-width:120px">Save</button></form></main>`;
export const clippedLabel = {
  defect: page(
    'Billing',
    '.field-label{display:block;overflow:hidden;white-space:nowrap}@media (max-width:480px){.field-label{width:110px}}',
    labelForm,
  ),
  corrected: page(
    'Billing',
    '.field-label{display:block;overflow:hidden}@media (max-width:480px){.field-label{width:110px;white-space:normal}}',
    labelForm,
  ),
};

// A fixed cookie banner: a corner card on wide screens, a full-width sheet on
// mobile that covers the submit button at the bottom of a one-screen page.
const checkout = `<main class="page"><h1>Checkout</h1><form style="max-width:400px"><label for="name" style="display:block">Name</label><input id="name" style="width:100%;height:40px"><button type="submit" style="display:block;margin-top:16px;height:44px;min-width:140px">Place order</button></form></main><div class="banner" role="region" aria-label="Cookie notice"><p style="margin:0 0 8px">We use cookies to keep you signed in.</p><button style="height:44px;min-width:64px">OK</button></div>`;
const checkoutCSS =
  '.page{min-height:100vh;display:flex;flex-direction:column;justify-content:flex-end;padding:24px 24px 40px}h1{margin:0 0 16px}.banner{position:fixed;right:16px;bottom:16px;width:280px;padding:12px;background:#222;color:#fff}';
export const stickyBanner = {
  defect: page(
    'Checkout',
    `${checkoutCSS}@media (max-width:480px){.banner{left:0;right:0;bottom:0;width:auto;height:180px}}`,
    checkout,
  ),
  corrected: page(
    'Checkout',
    `${checkoutCSS}@media (max-width:480px){.banner{position:static;width:auto}}`,
    checkout,
  ),
};

// An editor toolbar whose icon buttons shrink to 16px on mobile, next to an
// inline prose link and a labelled checkbox (both exempt under WCAG 2.5.8)
// and a visually hidden skip link (not rendered).
const editor = `<a class="skip" href="#editor">Skip to editor</a><main id="editor" style="padding:24px"><div class="toolbar" role="toolbar" aria-label="Formatting"><button aria-label="Bold">B</button><button aria-label="Italic">I</button><button aria-label="Underline">U</button><button aria-label="Link">L</button></div><p>Read the <a href="/guide">editing guide</a> for shortcuts.</p><label class="remember"><input type="checkbox"> Remember formatting</label></main>`;
const editorCSS =
  '.skip{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0)}.toolbar{display:flex;gap:4px}.toolbar button{width:32px;height:32px;padding:0}.remember{display:inline-block;padding:6px 0}';
export const iconToolbar = {
  defect: page(
    'Editor',
    `${editorCSS}@media (max-width:480px){.toolbar button{width:16px;height:16px;font-size:10px}}`,
    editor,
  ),
  corrected: page(
    'Editor',
    `${editorCSS}@media (max-width:480px){.toolbar button{width:28px;height:28px}}`,
    editor,
  ),
};

// Intentional layouts: decorative art overlapping the call to action and a
// one-slide-at-a-time carousel, plus a genuinely clipped promo label and tiny
// carousel dots that the narrow exceptions must not hide.
export const intentionalOverlap = page(
  'Launch',
  '.hero{position:relative;height:260px;padding:24px}.cta{position:absolute;left:40px;top:120px;width:160px;height:48px;display:flex;align-items:center;justify-content:center;background:#2255ac;color:#fff}.hero-art{position:absolute;left:110px;top:100px;width:200px;height:120px;background:radial-gradient(circle,#f7c948,transparent)}.carousel{width:300px;overflow:hidden;margin:0 24px}.track{display:flex}.slide{flex:0 0 300px;height:80px;padding:12px}.dots{display:flex;gap:4px;margin:8px 24px}.dots button{width:10px;height:10px;padding:0}.promo-label{width:80px;white-space:nowrap;overflow:hidden;margin:16px 24px}',
  `<section class="hero"><h1>Spring launch</h1><a class="cta" href="/start">Start trial</a><div class="hero-art"></div></section><div class="carousel" aria-label="Highlights"><div class="track"><div class="slide">Fast setup in minutes</div><div class="slide">Works offline <a href="/offline">Learn more</a></div><div class="slide">Bring your own data</div></div></div><div class="dots"><button aria-label="Slide 1"></button><button aria-label="Slide 2"></button><button aria-label="Slide 3"></button></div><p class="promo-label">Limited-time pricing</p>`,
);
