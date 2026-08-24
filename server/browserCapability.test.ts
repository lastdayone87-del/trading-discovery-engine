import assert from 'node:assert/strict'; import test from 'node:test'; import fs from 'node:fs';

import {
  BROWSER_RUNTIME_UNAVAILABLE,
  browserCapabilityIsUnavailable,
  browserCapabilitySnapshot,
  browserLaunchOptions,
  classifyBrowserFailure,
  markBrowserCapabilityReady,
  markBrowserCapabilityUnavailable,
} from './browserCapability';

test('browser path is fixed before the Playwright import is evaluated', () => {
  const source = fs.readFileSync(new URL('./browserCapability.ts', import.meta.url), 'utf8');
  assert.ok(source.indexOf("process.env.PLAYWRIGHT_BROWSERS_PATH = '0'") < source.indexOf("await import('playwright')"));
});

test('browser launch options are safe for the runtime user and shared by the probe and crawler', () => {
  const options = browserLaunchOptions();
  assert.equal(options.headless, true);
  if (process.getuid?.() === 0) assert.deepEqual(options.args, ['--no-sandbox', '--disable-setuid-sandbox']);
  else assert.equal(options.args, undefined);
});

test('browser runtime failures are classified separately from ordinary site failures', () => {
  assert.equal(classifyBrowserFailure(new Error("Executable doesn't exist at /app/.cache/ms-playwright/chromium")), 'BROWSER_BINARY_MISSING');
  assert.equal(classifyBrowserFailure(new Error('error while loading shared libraries: libgbm.so.1')), 'BROWSER_LINUX_DEPENDENCY_MISSING');
  assert.equal(classifyBrowserFailure(Object.assign(new Error('permission denied'), { code: 'EACCES' })), 'BROWSER_PERMISSION_DENIED');
  assert.equal(classifyBrowserFailure(new Error('navigation timeout exceeded')), 'BROWSER_LAUNCH_FAILED');
});

test('browser capability health is recoverable and never changes semantic provider controls', () => {
  const unavailable = markBrowserCapabilityUnavailable(new Error("Executable doesn't exist"));
  assert.equal(unavailable.status, 'UNAVAILABLE');
  assert.equal(unavailable.failureClass, 'BROWSER_BINARY_MISSING');
  assert.equal(browserCapabilityIsUnavailable(), true);
  const ready = markBrowserCapabilityReady('Chromium 140.0.0');
  assert.equal(ready.status, 'READY');
  assert.equal(ready.browserVersion, 'Chromium 140.0.0');
  assert.equal(browserCapabilityIsUnavailable(), false);
  assert.equal(BROWSER_RUNTIME_UNAVAILABLE, 'BROWSER_RUNTIME_UNAVAILABLE');
  assert.equal(browserCapabilitySnapshot().status, 'READY');
});
