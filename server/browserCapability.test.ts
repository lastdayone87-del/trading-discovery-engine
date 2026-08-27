import assert from 'node:assert/strict'; import test from 'node:test'; import fs from 'node:fs';
import { readFileSync } from 'node:fs';

import {
  BROWSER_RUNTIME_UNAVAILABLE,
  browserCapabilityIsUnavailable,
  browserCapabilitySnapshot,
  inspectBrowserExecutable,
  isBrowserRuntimeFailure,
  browserLaunchOptions,
  classifyBrowserFailure,
  markBrowserCapabilityReady,
  markBrowserCapabilityUnavailable,
  withBrowserRuntimeLease,
} from './browserCapability';

test('browser path configuration is preserved before the Playwright import is evaluated', () => {
  const source = fs.readFileSync(new URL('./browserCapability.ts', import.meta.url), 'utf8');
  assert.match(source, /Honor the runtime image's configured browser path/);
  assert.doesNotMatch(source, /process\.env\.PLAYWRIGHT_BROWSERS_PATH = '0'/);
});

test('production runtime pins the Playwright image and runs the app as the crawler user', () => {
  const dockerfile = readFileSync(new URL('../Dockerfile', import.meta.url), 'utf8');
  assert.match(dockerfile, /^FROM mcr\.microsoft\.com\/playwright:v1\.62\.1-noble/m);
  assert.match(dockerfile, /PLAYWRIGHT_BROWSERS_PATH=\/ms-playwright/);
  assert.match(dockerfile, /PLAYWRIGHT_SKIP_BROWSER_GC=1/);
  assert.match(dockerfile, /RUN chown -R pwuser:pwuser \/app/);
  assert.match(dockerfile, /USER pwuser/);
  assert.match(dockerfile, /CMD \["npm", "run", "start"\]/);
  assert.doesNotMatch(dockerfile, /npm run migrate && npm run start/);
});

test('browser launch options are safe for the runtime user and shared by the probe and crawler', () => {
  const options = browserLaunchOptions();
  assert.equal(options.headless, true);
  assert.equal(options.timeout >= 5_000 && options.timeout <= 30_000, true);
  if (process.getuid?.() === 0) assert.deepEqual(options.args, ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']);
  else assert.equal(options.args, undefined);
});

test('browser runtime lease serializes probe and crawler operations', async () => {
  const events: string[] = [];
  const first = withBrowserRuntimeLease(async () => {
    events.push('first:start');
    await new Promise(resolve => setTimeout(resolve, 5));
    events.push('first:end');
  });
  const second = withBrowserRuntimeLease(async () => {
    events.push('second:start');
    events.push('second:end');
  });
  await Promise.all([first, second]);
  assert.deepEqual(events, ['first:start', 'first:end', 'second:start', 'second:end']);
});

test('browser monitor schedules bounded recovery checks after each completed probe', () => {
  const source = fs.readFileSync(new URL('./browserCapability.ts', import.meta.url), 'utf8');
  assert.match(source, /const nextIntervalMs = result\.status === 'READY' \? healthyIntervalMs : degradedIntervalMs/);
  assert.match(source, /timer = setTimeout\(\(\) => \{ void check\(\); \}, nextIntervalMs\)/);
  assert.doesNotMatch(source, /const timer = setInterval/);
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

test('browser executable diagnostics expose only safe permission metadata', async () => {
  const probe = await inspectBrowserExecutable(process.execPath);
  assert.equal(probe.exists, true);
  assert.equal(probe.readableByProcess, true);
  assert.equal(probe.executableByProcess, true);
  assert.match(probe.mode || '', /^0?[0-7]{3,4}$/);
  assert.equal('path' in probe, false);
});

test('browser capability attestation metadata is bounded and does not expose launch errors', () => {
  const failed = markBrowserCapabilityUnavailable(new Error('private launch detail must not be persisted'));
  assert.equal(failed.status, 'UNAVAILABLE');
  assert.equal(failed.consecutiveFailures >= 1, true);
  assert.equal(failed.failureClass, 'BROWSER_LAUNCH_FAILED');
  assert.equal('message' in failed, false);
  assert.equal('cause' in failed, false);
  assert.equal('path' in (failed.executableProbe || {}), false);
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
