import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Page } from 'playwright';
import { protectedScreenshot } from '../src/drivers/playwright-evidence.js';

// A page whose screenshots fail with these errors, in order, then succeed.
const failing = (errors: string[]) => {
  let calls = 0;
  const page = {
    async screenshot() {
      calls++;
      const error = errors.shift();
      if (error) throw new Error(error);
      return Buffer.from('png');
    },
    async waitForTimeout() {},
  } as unknown as Page;
  return { page, calls: () => calls };
};

test('a capture Chromium fails while compositing is taken once more; other failures are not retried', async () => {
  const transient = failing([
    'page.screenshot: Protocol error (Page.captureScreenshot): Unable to capture screenshot',
  ]);
  assert.deepEqual(
    await protectedScreenshot(transient.page, undefined),
    Buffer.from('png'),
  );
  assert.equal(transient.calls(), 2);
  // Twice in a row is a real failure.
  const twice = failing([
    'Unable to capture screenshot',
    'Unable to capture screenshot',
  ]);
  await assert.rejects(protectedScreenshot(twice.page, undefined), /Unable/);
  assert.equal(twice.calls(), 2);
  const closed = failing(['Target page, context or browser has been closed']);
  await assert.rejects(protectedScreenshot(closed.page, undefined), /closed/);
  assert.equal(closed.calls(), 1);
});
