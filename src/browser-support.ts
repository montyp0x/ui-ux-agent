// What each Playwright browser engine is verified to do, by real execution
// (test/cross-browser.test.ts runs every row on every engine that launches;
// README "Browser support" records what was executed where). Nothing here
// imports a browser library. A feature that was not executed on an engine is
// reported `unsupported` there with the reason below, never assumed to behave
// like Chromium. Changing a row needs the execution that proves it.
import type { AuditId } from './audits/config.js';

export type BrowserEngine = 'chromium' | 'firefox' | 'webkit';

// A run-wide gap, listed in quality.unsupported (src/quality.ts).
export type EngineGap = { id: string; reason: string };

const FIREFOX_UNVERIFIED =
  'Not verified on Firefox: the Playwright 1.61.1 Firefox build does not launch on the macOS machine this engine version was verified on, and no CI job runs Firefox, so no Firefox result has been checked';

const WEBKIT_TAB =
  'Not supported on WebKit: WebKit (macOS default keyboard navigation) moves Tab focus only between form fields, never to links or buttons, so focus order and indicators would be measured against a different tab model than Chromium and Firefox';

// null: verified on that engine. Every audit must be declared for every
// engine, so a new audit cannot be assumed to work on an engine it never ran
// on.
export const ENGINE_AUDIT_SUPPORT: Record<
  BrowserEngine,
  Record<AuditId, string | null>
> = {
  chromium: {
    'layout.horizontal-overflow': null,
    'accessibility.axe': null,
    'layout.responsive': null,
    'visual.baseline': null,
    'journey.state-checks': null,
    'keyboard.focus': null,
  },
  webkit: {
    'layout.horizontal-overflow': null,
    'accessibility.axe': null,
    'layout.responsive': null,
    'visual.baseline': null,
    'journey.state-checks': null,
    'keyboard.focus': WEBKIT_TAB,
  },
  firefox: {
    'layout.horizontal-overflow': FIREFOX_UNVERIFIED,
    'accessibility.axe': FIREFOX_UNVERIFIED,
    'layout.responsive': FIREFOX_UNVERIFIED,
    'visual.baseline': FIREFOX_UNVERIFIED,
    'journey.state-checks': FIREFOX_UNVERIFIED,
    'keyboard.focus': FIREFOX_UNVERIFIED,
  },
};

const NO_HISTORY =
  'The back action is not offered: reading the session history (including same-document entries) needs the Chrome DevTools Protocol, which only Chromium exposes';

// Run-wide gaps of an engine, listed on every result it produces.
export const ENGINE_GAPS: Record<BrowserEngine, EngineGap[]> = {
  chromium: [],
  webkit: [{ id: 'navigation.back', reason: NO_HISTORY }],
  firefox: [
    { id: 'engine.firefox', reason: FIREFOX_UNVERIFIED },
    { id: 'navigation.back', reason: NO_HISTORY },
  ],
};

// Engines on which a keyboard-only journey (input: keyboard) is refused at
// suite validation, with the reason.
export const KEYBOARD_JOURNEY_UNSUPPORTED: Partial<
  Record<BrowserEngine, string>
> = {
  webkit: `Keyboard-only journeys are refused on WebKit: ${WEBKIT_TAB.replace(/^Not supported on WebKit: /, '')}`,
};

// Why an audit does not run on an engine, or null when it is verified there.
export function engineAuditGap(
  engine: BrowserEngine,
  id: AuditId,
): string | null {
  return ENGINE_AUDIT_SUPPORT[engine][id];
}

// Browser-context emulation of user settings, by engine, as executed
// (test/cross-browser.test.ts). applied: the page reads the setting back
// (matchMedia, navigator.language, Intl) and renders with it. media-only:
// the media query matches but the engine does not render the setting (for
// forced colors: author colours are not replaced), so a read-back alone would
// wrongly report it applied. untested: never executed on the engine.
export type EmulationSupport = 'applied' | 'media-only' | 'untested';
export type EmulatedSetting =
  | 'colorScheme'
  | 'reducedMotion'
  | 'forcedColors'
  | 'contrast'
  | 'locale'
  | 'timezoneId';
export const ENGINE_EMULATION: Record<
  BrowserEngine,
  Record<EmulatedSetting, EmulationSupport>
> = {
  chromium: {
    colorScheme: 'applied',
    reducedMotion: 'applied',
    forcedColors: 'applied',
    contrast: 'applied',
    locale: 'applied',
    timezoneId: 'applied',
  },
  webkit: {
    colorScheme: 'applied',
    reducedMotion: 'applied',
    forcedColors: 'media-only',
    contrast: 'applied',
    locale: 'applied',
    timezoneId: 'applied',
  },
  firefox: {
    colorScheme: 'untested',
    reducedMotion: 'untested',
    forcedColors: 'untested',
    contrast: 'untested',
    locale: 'untested',
    timezoneId: 'untested',
  },
};

// CSS Typed OM (element.computedStyleMap()), by engine, as executed.
// lengths: computed padding, margin and border radii are CSSUnitValue px.
// partial: the API exists and padding/margin are CSSUnitValue, but border
// radius longhands come back as an untyped CSSStyleValue ("8px"), which
// CSSNumericValue.parse(String(value)) turns into a CSSUnitValue.
export type TypedOMSupport = 'lengths' | 'partial' | 'absent' | 'untested';
export const ENGINE_TYPED_OM: Record<BrowserEngine, TypedOMSupport> = {
  chromium: 'lengths',
  webkit: 'partial',
  firefox: 'untested',
};
