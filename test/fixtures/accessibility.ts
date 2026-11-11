// Controlled pages for the accessibility scan tests: each page carries known
// violations of one kind, and its corrected twin fixes exactly those. Every
// page has a language, title, main landmark and heading, so best-practice
// rules about page structure do not fire on the twins.
const page = (title: string, body: string) =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${title}</title></head><body><main><h1>${title}</h1>${body}</main></body></html>`;

const icon =
  'data:image/svg+xml,%3Csvg xmlns="http://www.w3.org/2000/svg" width="16" height="16"%3E%3Crect width="16" height="16"/%3E%3C/svg%3E';

export type AccessibilityFixture = {
  broken: string;
  fixed: string;
  // Rule ids the broken page must report as violations.
  violations: string[];
};

export const accessibilityFixtures = {
  accessibleNames: {
    broken: page(
      'Accessible names',
      `<button type="button"><svg width="16" height="16" aria-hidden="true"><rect width="16" height="16"/></svg></button>
<p><a href="/next"><svg width="16" height="16" aria-hidden="true"><path d="M0 8h16"/></svg></a></p>
<img src='${icon}'>`,
    ),
    fixed: page(
      'Accessible names',
      `<button type="button" aria-label="Close"><svg width="16" height="16" aria-hidden="true"><rect width="16" height="16"/></svg></button>
<p><a href="/next">Next page <svg width="16" height="16" aria-hidden="true"><path d="M0 8h16"/></svg></a></p>
<img src='${icon}' alt="Company logo">`,
    ),
    violations: ['button-name', 'link-name', 'image-alt'],
  },
  formLabels: {
    broken: page(
      'Form labels',
      `<form><input type="text" name="email"><select name="plan"><option>Basic</option><option>Pro</option></select><button type="submit">Save</button></form>`,
    ),
    fixed: page(
      'Form labels',
      `<form><label for="email">Email</label><input type="text" id="email" name="email"><label for="plan">Plan</label><select id="plan" name="plan"><option>Basic</option><option>Pro</option></select><button type="submit">Save</button></form>`,
    ),
    violations: ['label', 'select-name'],
  },
  semantics: {
    broken: page(
      'Semantics',
      `<div role="buton" tabindex="0">Open</div>
<button type="button" aria-pressed="maybe">Bold</button>
<p aria-labelled="intro">Introduction</p>
<ul><div>First item</div></ul>`,
    ),
    fixed: page(
      'Semantics',
      `<div role="button" tabindex="0">Open</div>
<button type="button" aria-pressed="false">Bold</button>
<p id="intro">Introduction</p>
<ul><li>First item</li></ul>`,
    ),
    violations: [
      'aria-roles',
      'aria-valid-attr-value',
      'aria-valid-attr',
      'list',
    ],
  },
  contrast: {
    broken: page(
      'Contrast',
      `<p style="color:#aaaaaa;background:#ffffff">Light grey body text on white</p>`,
    ),
    fixed: page(
      'Contrast',
      `<p style="color:#333333;background:#ffffff">Dark grey body text on white</p>`,
    ),
    violations: ['color-contrast'],
  },
} satisfies Record<string, AccessibilityFixture>;

// Text over a background image: axe cannot compute the contrast, so it must
// report the check as incomplete (manual review), not as a pass or violation.
export const contrastNeedsReview = page(
  'Contrast over an image',
  `<p style="color:#777777;background-image:linear-gradient(90deg,#ffffff,#000000);padding:8px">Text over a gradient</p>`,
);
