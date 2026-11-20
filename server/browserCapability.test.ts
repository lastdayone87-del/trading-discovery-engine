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

test('browser startup timeouts keep browser-launch classification despite timeout wording', () => {
  // The timeout exclusion must not swallow timeouts explicitly tied to
  // browser startup: launch markers take precedence over timeout wording.
  assert.equal(isBrowserRuntimeFailure(new Error('browserType.launch: Timeout 15000ms exceeded.')), true);
  assert.equal(isBrowserRuntimeFailure(new Error('Failed to launch browser: Timeout 30000ms exceeded')), true);
  assert.equal(isBrowserRuntimeFailure(new Error('browser process exited: Timeout 5000ms exceeded')), true);
  // Ordinary navigation/request/handler timeouts stay excluded.
  assert.equal(isBrowserRuntimeFailure(new Error('Page.goto: Timeout 15000ms exceeded.')), false);
  assert.equal(isBrowserRuntimeFailure(new Error('navigation timeout of 15000ms exceeded')), false);
  assert.equal(isBrowserRuntimeFailure(new Error('net::ERR_CONNECTION_TIMED_OUT')), false);
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

test('resource safety: a second browser slot is granted only with memory headroom', async () => {
  const { setBrowserRuntimeLimitForTests, setMemoryHeadroomReaderForTests, withBrowserRuntimeLease } = await import('./browserCapability');
  const restoreLimit = setBrowserRuntimeLimitForTests(2);
  const restoreReader = setMemoryHeadroomReaderForTests({ host: () => 4_000, containerLimit: () => null, containerUsage: () => null });
  try {
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
    assert.deepEqual(events, ['first:start', 'second:start', 'second:end', 'first:end'],
      'with headroom, the second slot runs concurrently with the first');
  } finally {
    setBrowserRuntimeLimitForTests(restoreLimit);
    setMemoryHeadroomReaderForTests(restoreReader);
  }
});

test('resource safety: without memory headroom the lease stays single-slot', async () => {
  const { setBrowserRuntimeLimitForTests, setMemoryHeadroomReaderForTests, withBrowserRuntimeLease } = await import('./browserCapability');
  const restoreLimit = setBrowserRuntimeLimitForTests(2);
  const restoreReader = setMemoryHeadroomReaderForTests({ host: () => 400, containerLimit: () => null, containerUsage: () => null });
  try {
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
    assert.deepEqual(events, ['first:start', 'first:end', 'second:start', 'second:end'],
      'a degraded host falls back to single-slot behavior for new launches');
  } finally {
    setBrowserRuntimeLimitForTests(restoreLimit);
    setMemoryHeadroomReaderForTests(restoreReader);
  }
});

test('resource safety: slot one is always possible even on a degraded host', async () => {
  const { setBrowserRuntimeLimitForTests, setMemoryHeadroomReaderForTests, hostMemAvailableForExtraSlot } = await import('./browserCapability');
  const restoreLimit = setBrowserRuntimeLimitForTests(2);
  const restoreReader = setMemoryHeadroomReaderForTests({ host: () => 100, containerLimit: () => null, containerUsage: () => null });
  try {
    assert.equal(hostMemAvailableForExtraSlot(), null, 'below-threshold host denies the extra slot');
    let completed = 0;
    await withBrowserRuntimeLease(async () => { completed = 1; });
    assert.equal(completed, 1, 'a single browser launch must remain possible regardless of headroom');
  } finally {
    setBrowserRuntimeLimitForTests(restoreLimit);
    setMemoryHeadroomReaderForTests(restoreReader);
  }
});

test('resource safety: unreadable host memory telemetry fails open to the configured limit', async () => {
  const { setBrowserRuntimeLimitForTests, setMemoryHeadroomReaderForTests, withBrowserRuntimeLease } = await import('./browserCapability');
  const restoreLimit = setBrowserRuntimeLimitForTests(2);
  const restoreReader = setMemoryHeadroomReaderForTests({ host: () => null, containerLimit: () => null, containerUsage: () => null });
  try {
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
    assert.deepEqual(events, ['first:start', 'second:start', 'second:end', 'first:end'],
      'an unreadable /proc/meminfo must not brick an operator-configured second slot');
  } finally {
    setBrowserRuntimeLimitForTests(restoreLimit);
    setMemoryHeadroomReaderForTests(restoreReader);
  }
});

test('resource safety: BROWSER_EXTRA_SLOT_MIN_HOST_MEM_MB overrides the default threshold', async () => {
  const { setMemoryHeadroomReaderForTests, hostMemAvailableForExtraSlot } = await import('./browserCapability');
  const restoreReader = setMemoryHeadroomReaderForTests({ host: () => 1_600, containerLimit: () => null, containerUsage: () => null });
  const previousEnv = process.env.BROWSER_EXTRA_SLOT_MIN_HOST_MEM_MB;
  process.env.BROWSER_EXTRA_SLOT_MIN_HOST_MEM_MB = '2000';
  try {
    assert.equal(hostMemAvailableForExtraSlot(), null, '1600MB is below the raised 2000MB threshold');
    process.env.BROWSER_EXTRA_SLOT_MIN_HOST_MEM_MB = '1000';
    assert.equal(hostMemAvailableForExtraSlot(), 1_600, '1600MB clears the lowered 1000MB threshold');
  } finally {
    if (previousEnv === undefined) delete process.env.BROWSER_EXTRA_SLOT_MIN_HOST_MEM_MB;
    else process.env.BROWSER_EXTRA_SLOT_MIN_HOST_MEM_MB = previousEnv;
    setMemoryHeadroomReaderForTests(restoreReader);
  }
});

test('resource safety: a tight cgroup limit caps the container headroom even with high host memory', async () => {
  const { setMemoryHeadroomReaderForTests, hostMemAvailableForExtraSlot } = await import('./browserCapability');
  const restoreReader = setMemoryHeadroomReaderForTests({
    host: () => 5_000,
    containerLimit: () => 1_200,
    containerUsage: () => 900,
  });
  try {
    assert.equal(hostMemAvailableForExtraSlot(), null,
      'a container limited to 1200MB with 900MB used has only 300MB headroom — deny the extra slot');
    setMemoryHeadroomReaderForTests({ containerLimit: () => 4_000, containerUsage: () => 900 });
    assert.equal(hostMemAvailableForExtraSlot(), 3_100,
      'a roomy container limit passes the container headroom through');
    setMemoryHeadroomReaderForTests({ containerLimit: () => null, containerUsage: () => 900 });
    assert.equal(hostMemAvailableForExtraSlot(), 5_000,
      'an unbounded cgroup falls back to the host reading alone');
  } finally {
    setMemoryHeadroomReaderForTests(restoreReader);
  }
});

test('resource safety: a queued waiter is not promoted when memory degraded while two slots ran', async () => {
  const { setBrowserRuntimeLimitForTests, setMemoryHeadroomReaderForTests, withBrowserRuntimeLease } = await import('./browserCapability');
  const restoreLimit = setBrowserRuntimeLimitForTests(2);
  let hostAvailableMb = 4_000;
  const restoreReader = setMemoryHeadroomReaderForTests({ host: () => hostAvailableMb });
  try {
    const events: string[] = [];
    const holdSlots: Array<() => void> = [];
    const releaseAll = async (): Promise<void> => {
      for (const release of holdSlots.splice(0)) await release();
    };
    const first = withBrowserRuntimeLease(async () => { await new Promise<void>(resolve => holdSlots.push(resolve)); events.push('first:done'); });
    const second = withBrowserRuntimeLease(async () => { await new Promise<void>(resolve => holdSlots.push(resolve)); events.push('second:done'); });
    await new Promise(resolve => setTimeout(resolve, 10));
    assert.deepEqual(events, [], 'both slots are held by the test until released');
    // A third request queues behind the two held slots while memory is fine.
    const third = withBrowserRuntimeLease(async () => { events.push('third:done'); });
    await new Promise(resolve => setTimeout(resolve, 10));
    // Memory degrades before the first slot releases.
    hostAvailableMb = 400;
    await holdSlots.shift()!();
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.deepEqual(events, ['first:done'],
      'releasing the first slot must not promote the queued waiter on a degraded host');
    // The remaining release drops active to zero, where slot one is always
    // possible again, so the waiter proceeds.
    hostAvailableMb = 400;
    await holdSlots.shift()!();
    await Promise.all([second, third]);
    assert.deepEqual(events, ['first:done', 'second:done', 'third:done'],
      'once only one launch can run, the queued work proceeds');
  } finally {
    setBrowserRuntimeLimitForTests(restoreLimit);
    setMemoryHeadroomReaderForTests(restoreReader);
  }
});

test('Dockerfile defaults match the validated browser-capacity configuration', () => {
  const dockerfile = readFileSync(new URL('../Dockerfile', import.meta.url), 'utf8');
  assert.match(dockerfile, /BROWSER_RUNTIME_CONCURRENCY=2\b/,
    'the validated experiment config runs two memory-guarded browser slots');
  assert.match(dockerfile, /RENDERED_ADMISSION_NOMINAL_PER_HOUR=64\b/,
    'nominal admission budget must track the measured two-slot lease capacity');
  assert.match(dockerfile, /RENDERED_ADMISSION_EMERGENCY_PER_HOUR=72\b/,
    'emergency allowance must stay above nominal and within lease capacity');
  assert.match(dockerfile, /RENDERED_ADMISSION_DISCOVERY_FLOOR_PCT=35\b/);
});
