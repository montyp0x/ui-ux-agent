// What each Playwright browser engine is verified to do, by real execution
// (test/cross-browser.test.ts runs every row on every engine that launches;
// README "Browser support" records what was executed where). Nothing here
// imports a browser library. A feature that was not executed on an engine is
// reported `unsupported` there with the reason below, never assumed to behave
// like Chromium. Changing a row needs the execution that proves it.
import type { AuditId } from './audits/config.js';
import type { Environment } from './environments.js';

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
    'design.tokens': null,
    'performance.web': null,
  },
  webkit: {
    'layout.horizontal-overflow': null,
    'accessibility.axe': null,
    'layout.responsive': null,
    'visual.baseline': null,
    'journey.state-checks': null,
    'keyboard.focus': WEBKIT_TAB,
    'design.tokens': null,
    'performance.web': null,
  },
  firefox: {
    'layout.horizontal-overflow': FIREFOX_UNVERIFIED,
    'accessibility.axe': FIREFOX_UNVERIFIED,
    'layout.responsive': FIREFOX_UNVERIFIED,
    'visual.baseline': FIREFOX_UNVERIFIED,
    'journey.state-checks': FIREFOX_UNVERIFIED,
    'keyboard.focus': FIREFOX_UNVERIFIED,
    'design.tokens': FIREFOX_UNVERIFIED,
    'performance.web': FIREFOX_UNVERIFIED,
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
// pseudoLocalization is the harness's init script (src/environments.ts),
// not a context option: applied means the page's text was padded.
export type EmulationSupport = 'applied' | 'media-only' | 'untested';
export type EmulatedSetting =
  | 'colorScheme'
  | 'reducedMotion'
  | 'forcedColors'
  | 'contrast'
  | 'locale'
  | 'timezoneId'
  | 'pseudoLocalization';
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
    pseudoLocalization: 'applied',
  },
  webkit: {
    colorScheme: 'applied',
    reducedMotion: 'applied',
    forcedColors: 'media-only',
    contrast: 'applied',
    locale: 'applied',
    timezoneId: 'applied',
    pseudoLocalization: 'applied',
  },
  firefox: {
    colorScheme: 'untested',
    reducedMotion: 'untested',
    forcedColors: 'untested',
    contrast: 'untested',
    locale: 'untested',
    timezoneId: 'untested',
    pseudoLocalization: 'untested',
  },
};

const ENGINE_LABEL: Record<BrowserEngine, string> = {
  chromium: 'Chromium',
  firefox: 'Firefox',
  webkit: 'WebKit',
};

// Environment fields (src/environments.ts) and the setting each emulates,
// in the order gaps are listed.
const ENVIRONMENT_SETTINGS = [
  ['locale', 'locale'],
  ['timezone', 'timezoneId'],
  ['colorScheme', 'colorScheme'],
  ['reducedMotion', 'reducedMotion'],
  ['forcedColors', 'forcedColors'],
  ['contrast', 'contrast'],
  ['pseudoLocalization', 'pseudoLocalization'],
] as const satisfies readonly (readonly [keyof Environment, EmulatedSetting])[];

function emulationGap(
  engine: BrowserEngine,
  field: keyof Environment,
  support: EmulationSupport,
): string {
  if (support === 'untested')
    return engine === 'firefox'
      ? `${field} is not emulated: ${FIREFOX_UNVERIFIED}`
      : `${field} is not emulated: never executed on ${ENGINE_LABEL[engine]}`;
  // media-only: today only forced colours (see ENGINE_EMULATION).
  return `${field} is not emulated on ${ENGINE_LABEL[engine]}: the media query matches, but author colours are not replaced, so the page would be measured in a state no user of the engine sees`;
}

// What of an environment the engine emulates. `environment` keeps only the
// settings the engine applies; every other requested setting is withheld
// (never half-applied: a media-only setting would change the media query
// without the rendering) and listed in `unsupported` with the engine's
// reason, as `environment.<field>`. A setting set to its no-op value
// (forcedColors none) is applied wherever the engine renders it.
export function environmentEmulation(
  engine: BrowserEngine,
  environment: Environment,
): { environment: Environment; unsupported: EngineGap[] } {
  const applied: Environment = { ...environment };
  const unsupported: EngineGap[] = [];
  for (const [field, setting] of ENVIRONMENT_SETTINGS) {
    if (environment[field] === undefined) continue;
    const support = ENGINE_EMULATION[engine][setting];
    const appliedHere =
      support === 'applied' ||
      (support === 'media-only' &&
        field === 'forcedColors' &&
        environment.forcedColors === 'none');
    if (appliedHere) continue;
    delete applied[field];
    unsupported.push({
      id: `environment.${field}`,
      reason: emulationGap(engine, field, support),
    });
  }
  return { environment: applied, unsupported };
}

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
