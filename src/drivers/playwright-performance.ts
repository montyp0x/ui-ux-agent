// The Playwright side of performance.web (src/audits/performance.ts):
//
// - before the first navigation, a fixed collector script is added to the
//   page (it observes the browser's performance timeline in every document)
//   and, when the suite configures conditions, network and CPU throttling is
//   applied to the session through Chromium's DevTools protocol;
// - the session reports its screenshot captures and the page work of other
//   audits here, so harness time is kept apart from app metrics;
// - at a checkpoint, the audit waits (bounded) for the document's load
//   event, lets pending observer callbacks run, and reads what the collector
//   recorded. The page's answer is parsed with rawPerformanceSchema.
//
// Only this engine code runs in the page: never model-generated script. The
// scripts are plain strings, so no bundler helper ends up in the page.
import type { BrowserContext, Page } from 'playwright';
import type { Suite } from '../contracts.js';
import type { AuditOutput } from '../audits/contract.js';
import {
  conditionsRecord,
  performanceOutput,
  rawPerformanceSchema,
  type HarnessInterval,
  type PerformanceAuditConfig,
} from '../audits/performance.js';
import type { PerformanceConditionsRecord } from '../audits/performance-contract.js';
import type { DriverAuditRequest, EventLogger } from './types.js';

const KEY = 'ui-ux-agent.performance';

// Runs at the start of every top-level document. `selectors` are the
// suite's interactionTargets (JSON data, not code).
const COLLECTOR = `(function (selectors) {
  if (window.top !== window) return;
  var key = Symbol.for(${JSON.stringify(KEY)});
  if (window[key]) return;
  var types = (typeof PerformanceObserver !== 'undefined' && PerformanceObserver.supportedEntryTypes) || [];
  var CAP = 500;
  var state = { supported: Array.prototype.slice.call(types), paints: [], lcp: [], shifts: [], events: [], inputs: [], longTasks: [], dropped: 0, errors: [] };
  Object.defineProperty(window, key, { value: state, enumerable: false });
  function push(list, item) { if (list.length < CAP) list.push(item); else state.dropped++; }
  function describe(node) {
    if (!node || node.nodeType !== 1 || !node.tagName) return null;
    var text = String(node.tagName).toLowerCase();
    if (node.id) text += '#' + String(node.id).slice(0, 60);
    var names = typeof node.className === 'string' ? node.className.trim().split(/\\s+/).filter(Boolean).slice(0, 2) : [];
    for (var i = 0; i < names.length; i++) text += '.' + names[i].slice(0, 40);
    return text.slice(0, 200);
  }
  function matches(node) {
    var found = [];
    if (!node || node.nodeType !== 1 || !node.closest) return found;
    for (var i = 0; i < selectors.length; i++) {
      try { if (node.closest(selectors[i])) found.push(i); }
      catch (error) { if (state.errors.length < 20) state.errors.push('interactionTargets[' + i + ']: ' + String(error && error.message || error).slice(0, 200)); }
    }
    return found;
  }
  function observe(type, options, handle) {
    if (types.indexOf(type) < 0) return;
    try {
      var observer = new PerformanceObserver(function (list) {
        var entries = list.getEntries();
        for (var i = 0; i < entries.length; i++) handle(entries[i]);
      });
      var init = { type: type, buffered: true };
      for (var name in options) init[name] = options[name];
      observer.observe(init);
    } catch (error) {
      if (state.errors.length < 20) state.errors.push(type + ': ' + String(error && error.message || error).slice(0, 200));
    }
  }
  observe('paint', {}, function (entry) { if (state.paints.length < 10) state.paints.push({ name: String(entry.name).slice(0, 60), startTime: entry.startTime }); });
  observe('largest-contentful-paint', {}, function (entry) { push(state.lcp, { startTime: entry.startTime, size: entry.size || 0, element: describe(entry.element) }); });
  observe('layout-shift', {}, function (entry) { push(state.shifts, { startTime: entry.startTime, value: entry.value, hadRecentInput: !!entry.hadRecentInput }); });
  observe('event', { durationThreshold: 16 }, function (entry) {
    if (!entry.interactionId) return;
    push(state.events, { name: String(entry.name).slice(0, 40), startTime: entry.startTime, duration: entry.duration, processingStart: entry.processingStart, processingEnd: entry.processingEnd, interactionId: entry.interactionId, target: describe(entry.target), matches: matches(entry.target) });
  });
  observe('longtask', {}, function (entry) { push(state.longTasks, { startTime: entry.startTime, duration: entry.duration }); });
  function input(event) {
    if (!event.isTrusted || event.repeat) return;
    push(state.inputs, { type: event.type, at: event.timeStamp, target: describe(event.target), matches: matches(event.target) });
  }
  window.addEventListener('pointerdown', input, { capture: true, passive: true });
  window.addEventListener('keydown', input, { capture: true, passive: true });
})`;

// Reads the collector's state and the navigation entry of the document.
const READ = `(function () {
  var state = window[Symbol.for(${JSON.stringify(KEY)})];
  var nav = performance.getEntriesByType ? performance.getEntriesByType('navigation')[0] : undefined;
  var copy = function (list) { return list ? list.slice(0, 500) : []; };
  return {
    installed: !!state,
    url: String(location.href).slice(0, 4000),
    timeOrigin: performance.timeOrigin,
    now: performance.now(),
    supported: state ? state.supported.slice(0, 60) : [],
    navigation: nav ? { type: String(nav.type).slice(0, 40), activationStart: nav.activationStart || 0, responseStart: nav.responseStart || 0, responseEnd: nav.responseEnd || 0, domContentLoadedEventEnd: nav.domContentLoadedEventEnd || 0, loadEventEnd: nav.loadEventEnd || 0 } : null,
    paints: state ? state.paints.slice(0, 10) : [],
    lcp: copy(state && state.lcp),
    shifts: copy(state && state.shifts),
    events: copy(state && state.events),
    inputs: copy(state && state.inputs),
    longTasks: copy(state && state.longTasks),
    dropped: state ? state.dropped : 0,
    errors: state ? state.errors.slice(0, 20) : []
  };
})()`;

// Two frames and a task, so entries of the last paint reach the observers.
const SETTLE = `new Promise(function (resolve) {
  var done = function () { setTimeout(resolve, 0); };
  if (typeof requestAnimationFrame !== 'function' || document.visibilityState !== 'visible') return done();
  requestAnimationFrame(function () { requestAnimationFrame(done); });
})`;

// Other audits' page work and the session's screenshots, recorded by the
// web driver for the performance.web runs of the session.
export class PerformanceRecorder {
  screenshots = 0;
  screenshotMs = 0;
  readonly intervals: HarnessInterval[] = [];
  // Set when applying them failed in Chromium.
  failure: string | null = null;

  constructor(
    readonly config: PerformanceAuditConfig,
    readonly browser: string,
    public conditions: PerformanceConditionsRecord,
  ) {}

  screenshot(ms: number): void {
    this.screenshots++;
    this.screenshotMs += Math.max(0, ms);
  }

  // Another audit's page work, start to end (wall clock).
  async during<T>(work: () => Promise<T>): Promise<T> {
    const start = Date.now();
    try {
      return await work();
    } finally {
      if (this.intervals.length < 500)
        this.intervals.push({ start, end: Date.now() });
    }
  }
}

const performanceConfig = (suite: Suite): PerformanceAuditConfig | null => {
  const check = suite.audits.checks.find(
    (entry) => entry.id === 'performance.web',
  );
  return check?.id === 'performance.web' ? check : null;
};

// Installs the collector and applies the configured conditions before the
// session's first navigation. Null when the suite has no performance.web.
export async function preparePerformance(
  context: BrowserContext,
  page: Page,
  suite: Suite,
  browserName: Suite['browser'],
  log: EventLogger,
): Promise<PerformanceRecorder | null> {
  const config = performanceConfig(suite);
  if (!config) return null;
  const recorder = new PerformanceRecorder(
    config,
    browserName,
    conditionsRecord(config, !config.conditions),
  );
  await page.addInitScript({
    content: `${COLLECTOR}(${JSON.stringify(config.interactionTargets)})`,
  });
  if (!config.conditions) return recorder;
  // Outside Chromium the runner never calls the audit: the engine support
  // table (src/browser-support.ts ENGINE_AUDIT_OPTIONS) reports configured
  // conditions unsupported there. Nothing is applied.
  if (browserName !== 'chromium') {
    await log('performance_conditions', {
      applied: false,
      browser: browserName,
      reason: 'unsupported',
    });
    return recorder;
  }
  const { network, cpuSlowdown } = recorder.conditions;
  try {
    const cdp = await context.newCDPSession(page);
    if (network) {
      await cdp.send('Network.enable');
      await cdp.send('Network.emulateNetworkConditions', {
        offline: false,
        latency: network.latencyMs,
        // DevTools takes bytes per second.
        downloadThroughput: (network.downloadKbps * 1000) / 8,
        uploadThroughput: (network.uploadKbps * 1000) / 8,
      });
    }
    if (cpuSlowdown !== null)
      await cdp.send('Emulation.setCPUThrottlingRate', { rate: cpuSlowdown });
    recorder.conditions = { ...recorder.conditions, applied: true };
  } catch (caught) {
    recorder.failure = (
      caught instanceof Error ? caught.message : String(caught)
    ).split('\n')[0]!;
  }
  await log('performance_conditions', {
    applied: recorder.conditions.applied,
    browser: browserName,
    networkProfile: recorder.conditions.networkProfile,
    network: recorder.conditions.network,
    cpuSlowdown: recorder.conditions.cpuSlowdown,
    ...(recorder.failure ? { error: recorder.failure } : {}),
  });
  return recorder;
}

// Bounded waits inside the audit's own timeout.
const LOAD_WAIT_MAX_MS = 10000;
const RESERVE_MS = 1500;

async function bounded<T>(work: Promise<T>, ms: number): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export async function performanceWebPlaywrightAudit(
  page: Page,
  request: DriverAuditRequest,
  recorder: PerformanceRecorder | null,
): Promise<AuditOutput> {
  if (!recorder)
    throw new Error(
      'performance.web needs the collector installed when the session opened',
    );
  if (recorder.failure)
    throw new Error(
      `Could not apply the performance conditions: ${recorder.failure}`,
    );
  const wait = Math.max(
    0,
    Math.min(LOAD_WAIT_MAX_MS, request.timeoutMs - RESERVE_MS),
  );
  let loadWaitedMs: number | null = null;
  try {
    await page.waitForLoadState('load', { timeout: Math.max(1, wait) });
  } catch {
    loadWaitedMs = wait;
  }
  await bounded(page.evaluate(SETTLE), 1000);
  const raw = rawPerformanceSchema.parse(await page.evaluate(READ));
  return performanceOutput(raw, {
    config: recorder.config,
    browser: recorder.browser,
    conditions: recorder.conditions,
    harnessIntervals: [...recorder.intervals],
    harness: request.harness
      ? {
          ...request.harness,
          screenshots: recorder.screenshots,
          screenshotMs: Math.round(recorder.screenshotMs),
        }
      : null,
    loadWaitedMs,
  });
}
