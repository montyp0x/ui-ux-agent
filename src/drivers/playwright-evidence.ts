// Screenshots with protections applied before capture: Playwright covers the
// masked elements in the page while the image is rendered, so the written
// image never contains them. An HTML overlay in the report would not protect
// the underlying file.
import type { Locator, Page, PageScreenshotOptions } from 'playwright';
import { locate } from '../browser.js';
import type { ScreenshotProtection } from '../evidence/protection.js';
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
