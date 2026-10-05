import { execFile } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);
const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const source = join(root, 'native', 'macos', 'fixture', 'FixtureApp.swift');
export const FIXTURE_BUNDLE_ID = 'dev.ui-ux-agent.fixture';
export const fixtureAppPath = join(root, '.build', 'UIFixture.app');

// Builds the deterministic SwiftUI fixture into a minimal, ad-hoc signed .app.
export async function buildFixtureApp(): Promise<string> {
  const executable = join(fixtureAppPath, 'Contents', 'MacOS', 'UIFixture');
  if (existsSync(executable) && statSync(executable).mtimeMs >= statSync(source).mtimeMs)
    return fixtureAppPath;
  await mkdir(dirname(executable), { recursive: true });
  await run('swiftc', ['-O', '-parse-as-library', source, '-o', executable]);
  await writeFile(
    join(fixtureAppPath, 'Contents', 'Info.plist'),
    `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>${FIXTURE_BUNDLE_ID}</string>
<key>CFBundleName</key><string>UI Fixture</string>
<key>CFBundleExecutable</key><string>UIFixture</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>LSMinimumSystemVersion</key><string>14.0</string>
<key>NSPrincipalClass</key><string>NSApplication</string>
</dict></plist>
`,
  );
  await run('codesign', ['--force', '--sign', '-', fixtureAppPath]);
  return fixtureAppPath;
}
