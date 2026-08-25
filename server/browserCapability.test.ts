import assert from 'node:assert/strict'; import test from 'node:test'; import fs from 'node:fs';

import {
  BROWSER_RUNTIME_UNAVAILABLE,
  browserCapabilityIsUnavailable,
  browserCapabilitySnapshot,
  isBrowserRuntimeFailure,
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

test('navigation timeouts remain page-level failures and do not demote browser capability', () => {
  assert.equal(isBrowserRuntimeFailure(new Error('Page.goto: Timeout 15000ms exceeded.')), false);
  markBrowserCapabilityReady('Chromium 151.0.0');
  assert.equal(browserCapabilityIsUnavailable(), false);
});

test('browser capability attestation metadata is bounded and does not expose launch errors', () => {
  const failed = markBrowserCapabilityUnavailable(new Error('private launch detail must not be persisted'));
  assert.equal(failed.status, 'UNAVAILABLE');
  assert.equal(failed.consecutiveFailures >= 1, true);
  assert.equal(failed.failureClass, 'BROWSER_LAUNCH_FAILED');
  assert.equal('message' in failed, false);
  assert.equal(failed.attestation, 'CHROMIUM_LAUNCH_CLOSE');
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
  const snapshot = browserCapabilitySnapshot();
  assert.equal(snapshot.status, 'READY');
  assert.equal(snapshot.consecutiveFailures, 0);
  assert.equal(snapshot.attestation, 'CHROMIUM_LAUNCH_CLOSE');
  assert.equal(snapshot.lastSuccessAt !== undefined, true);
});
