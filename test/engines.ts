// Which Playwright browser engines this machine can actually run, for tests
// that execute on every engine. An engine that is not installed, or that is
// installed but does not launch here, is skipped with the reason, the same
// way the native macOS tests skip off macOS: a skipped engine is never
// reported as verified. Install one with `npx playwright install <engine>`.
import { existsSync } from 'node:fs';
import { chromium, firefox, webkit, type BrowserType } from 'playwright';

export type Engine = 'chromium' | 'firefox' | 'webkit';
export const ENGINES: readonly Engine[] = ['chromium', 'firefox', 'webkit'];
export const ENGINE_TYPES: Record<Engine, BrowserType> = {
  chromium,
  firefox,
  webkit,
};

// A launch that has not finished by then is a browser that does not run here.
const PROBE_TIMEOUT_MS = 20_000;
const probes = new Map<Engine, Promise<string | false>>();

async function probe(engine: Engine): Promise<string | false> {
  const type = ENGINE_TYPES[engine];
  let executable: string;
  try {
    executable = type.executablePath();
  } catch (caught) {
    return `Playwright ${engine} is not available: ${String(caught).split('\n')[0]}`;
  }
  if (!existsSync(executable))
    return `Playwright ${engine} is not installed (npx playwright install ${engine})`;
  try {
    const browser = await type.launch({ timeout: PROBE_TIMEOUT_MS });
    await browser.close();
    return false;
  } catch (caught) {
    const message = caught instanceof Error ? caught.message : String(caught);
    return `Playwright ${engine} is installed but does not launch on this machine (${process.platform}): ${message.split('\n')[0]}`;
  }
}

// false when the engine runs here; otherwise why its tests are skipped.
// Probed once per test file, all engines in parallel.
export function engineSkip(engine: Engine): Promise<string | false> {
  if (!probes.has(engine)) probes.set(engine, probe(engine));
  return probes.get(engine)!;
}
