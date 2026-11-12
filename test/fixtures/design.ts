// Local pages for the design.tokens audit. `onToken` uses only the values in
// TOKENS; `offToken` is the same page with seeded off-token values, one per
// rule, each with a known nearest token. Neither page relies on browser
// default styles: every margin, padding, size and colour is set explicitly.
export const TOKENS = {
  version: 1,
  name: 'fixture tokens',
  color: {
    ink: '#1a1f36',
    paper: '#ffffff',
    brand: '#0b5fff',
    line: '#d0d5dd',
    danger: '#e5484d',
  },
  fontFamily: { body: 'Inter, Arial, sans-serif' },
  fontSize: { sm: '14px', md: '1rem', lg: 24 },
  spacing: { s1: '4px', s2: '8px', s3: '1rem', s4: '24px' },
  radius: { sm: '4px', md: '8px' },
} as const;

const BASE =
  '*{box-sizing:border-box;margin:0;padding:0}' +
  'html{font-size:16px}' +
  'body{font-family:Inter, Arial, sans-serif;font-size:16px;color:#1a1f36;background:#ffffff}' +
  // `margin: 0 auto` centres main: an auto margin is not a spacing value.
  'main{padding:24px;display:flex;flex-direction:column;gap:16px;max-width:640px;margin:0 auto}' +
  'h1{font-size:24px}' +
  'a{color:#0b5fff}' +
  '.card{border:1px solid #d0d5dd;border-radius:8px;padding:16px}' +
  '.cta{background:#0b5fff;color:#ffffff;border:0;border-radius:4px;padding:8px 16px;font:inherit;font-size:14px}' +
  '.hint{font-size:14px;margin-top:4px}' +
  // Percentages are relative values, not compared with the spacing scale.
  '.wide{padding-left:5%}' +
  '.hidden{display:none;color:#123456}';

const BODY =
  '<main><h1>Plan your trip</h1>' +
  '<section class="card"><p>Pick a destination and dates.</p>' +
  '<p class="hint">You can change them later.</p></section>' +
  '<p class="wide">Prices include taxes.</p>' +
  '<p><button class="cta" type="button">Search trips</button></p>' +
  '<p class="hidden">Never shown</p>' +
  '<p class="partner"><span class="partner-badge">Partner offer</span></p>' +
  '</main>';

const page = (css: string, body = BODY) =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Trips</title><style>${BASE}${css}</style></head><body>${body}</body></html>`;

// The partner badge uses the brand colours on the on-token page.
export const onToken = page(
  '.partner-badge{background:#0b5fff;color:#ffffff;padding:4px 8px;border-radius:4px}',
);

// Seeded off-token values and the nearest token each should report:
// - color: the button background #ff5a1f (nearest danger), the hint text
//   #555555 (nearest ink);
// - radius: the button's 6px corners (nearest sm 4px or md 8px, 2px away);
// - spacing: the button's 10px vertical padding (nearest s2 8px);
// - font-size: the hint's 13px (nearest sm 14px);
// - font-family: Georgia on the card's first paragraph (no family token).
// The partner badge carries #ffcc00, exempted by the suite in the tests.
export const offToken = page(
  '.cta{background:#ff5a1f;border-radius:6px;padding:10px 16px}' +
    '.hint{font-size:13px;color:#555555}' +
    '.card p:first-child{font-family:Georgia, serif}' +
    '.partner-badge{background:#ffcc00;color:#1a1f36;padding:4px 8px;border-radius:4px}',
);

// One pixel of colour drift (#0b5ffe for #0b5fff) and half a pixel of size:
// within the default tolerance, so still on token.
export const nearToken = page(
  '.cta{background:#0b5ffe}.hint{font-size:14.25px}' +
    '.partner-badge{background:#0b5fff;color:#ffffff;padding:4px 8px;border-radius:4px}',
);

// The same tokens in the W3C Design Tokens Community Group format: nested
// groups, an inherited $type, an alias and the object value forms.
export const DTCG_TOKENS = {
  $description: 'Fixture tokens in DTCG format',
  color: {
    $type: 'color',
    ink: { $value: '#1a1f36' },
    paper: { $value: '#ffffff' },
    brand: {
      $value: {
        colorSpace: 'srgb',
        components: [11 / 255, 95 / 255, 1],
        alpha: 1,
      },
    },
    line: { $value: '#d0d5dd' },
    danger: { $value: '#e5484d' },
    action: { $value: '{color.brand}' },
  },
  font: {
    family: {
      body: { $type: 'fontFamily', $value: ['Inter', 'Arial', 'sans-serif'] },
    },
    weight: { bold: { $type: 'fontWeight', $value: 700 } },
  },
  fontSize: {
    $type: 'dimension',
    sm: { $value: '14px' },
    md: { $value: { value: 1, unit: 'rem' } },
    lg: { $value: '24px' },
  },
  spacing: {
    $type: 'dimension',
    s1: { $value: '4px' },
    s2: { $value: '8px' },
    s3: { $value: '1rem' },
    s4: { $value: '24px' },
  },
  radius: {
    $type: 'dimension',
    sm: { $value: '4px' },
    md: { $value: '8px' },
  },
  shadow: { card: { $type: 'shadow', $value: { offsetX: '0px' } } },
};
