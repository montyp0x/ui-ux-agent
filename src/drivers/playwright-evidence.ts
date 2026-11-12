// Screenshots with protections applied before capture: Playwright covers the
// masked elements in the page while the image is rendered, so the written
// image never contains them. An HTML overlay in the report would not protect
// the underlying file.
import type { Locator, Page, PageScreenshotOptions } from 'playwright';
import { locate } from '../browser.js';
import type {
  EvidenceProtection,
  ScreenshotProtection,
} from '../evidence/protection.js';
import type { TextPattern } from '../evidence/redact.js';

// Drop the global flag and name named groups away: getByText tests each
// element's text, and several patterns are combined into one alternation.
function textRegex(patterns: readonly TextPattern[]): RegExp[] {
  const groups = new Map<boolean, string[]>();
  const alone: RegExp[] = [];
  for (const pattern of patterns) {
    const flags = pattern.flags.includes('i') ? 'i' : '';
    // Backreferences would point at the wrong group once combined.
    if (/\\[1-9]|\\k</.test(pattern.source)) {
      alone.push(new RegExp(pattern.source, flags));
      continue;
    }
    const source = pattern.source.replace(/\(\?<[A-Za-z]\w*>/g, '(?:');
    groups.set(!!flags, [...(groups.get(!!flags) ?? []), `(?:${source})`]);
  }
  return [
    ...[...groups].map(
      ([ignoreCase, sources]) =>
        new RegExp(sources.join('|'), ignoreCase ? 'i' : ''),
    ),
    ...alone,
  ];
}

const FIELDS = 'input:not([type=hidden]):not([type=password]), textarea';

// The locators to cover in a screenshot of the page's current state.
export async function screenshotMasks(
  page: Page,
  protection: ScreenshotProtection,
): Promise<Locator[]> {
  const regexes = textRegex(protection.patterns);
  const masks: Locator[] = [
    ...protection.masks.map((target) => locate(page, target)),
    ...regexes.map((regex) => page.getByText(regex)),
  ];
  if (regexes.length) {
    // Input values are not page text: find the fields whose current value
    // matches, by index, and cover them.
    const fields = page.locator(FIELDS);
    const matching = await fields
      .evaluateAll(
        (elements, sources) => {
          const tests = sources.map(
            ([source, flags]) => new RegExp(source!, flags),
          );
          return elements.flatMap((element, index) => {
            const value = (element as HTMLInputElement).value ?? '';
            return value && tests.some((test) => test.test(value))
              ? [index]
              : [];
          });
        },
        regexes.map((regex) => [regex.source, regex.flags]),
      )
      .catch(() => [] as number[]);
    masks.push(...matching.map((index) => fields.nth(index)));
    // A closed select draws its chosen option's text, which is not page text
    // getByText can cover: cover the select when the chosen option's value
    // or text matches (the value can name a secret the label does not show).
    // A list box (multiple, or size above 1) draws every option.
    const selects = page.locator('select');
    const chosen = await selects
      .evaluateAll(
        (elements, sources) => {
          const tests = sources.map(
            ([source, flags]) => new RegExp(source!, flags),
          );
          return elements.flatMap((element, index) => {
            const select = element as HTMLSelectElement;
            const options = Array.from(
              select.multiple || select.size > 1
                ? select.options
                : select.selectedOptions,
            );
            const shown = options.flatMap((option) => [
              option.value,
              option.label,
              option.text,
            ]);
            return shown.some(
              (text) => text && tests.some((test) => test.test(text)),
            )
              ? [index]
              : [];
          });
        },
        regexes.map((regex) => [regex.source, regex.flags]),
      )
      .catch(() => [] as number[]);
    masks.push(...chosen.map((index) => selects.nth(index)));
  }
  return masks;
}

// page.screenshot with the run's protections; without protection it is a
// plain screenshot. Returns the image like page.screenshot.
export async function protectedScreenshot(
  page: Page,
  protection: ScreenshotProtection | undefined,
  options: PageScreenshotOptions = {},
): Promise<Buffer> {
  if (!protection) return page.screenshot(options);
  return page.screenshot({
    ...options,
    mask: [
      ...(options.mask ?? []),
      ...(await screenshotMasks(page, protection)),
    ],
    maskColor: protection.maskColor,
  });
}

// Reads the page's select options so the protection learns the labels of
// options whose value is a secret (EvidenceProtection.learnOptionLabels).
// Called before anything the driver returns or logs can show page text.
// Top-level document only; never throws (the page may be navigating).
export async function learnSecretOptions(
  page: Page,
  protection: Pick<EvidenceProtection, 'learnOptionLabels'> | undefined,
): Promise<void> {
  if (!protection) return;
  const options = await page
    .locator('select option')
    .evaluateAll((elements) =>
      elements.map((element) => {
        const option = element as HTMLOptionElement;
        return { value: option.value, texts: [option.label, option.text] };
      }),
    )
    .catch(() => [] as { value: string; texts: string[] }[]);
  protection.learnOptionLabels(options);
}
