import { constants as fsConstants } from 'node:fs';
import { access, stat } from 'node:fs/promises';

export type BrowserCapabilityStatus = 'UNKNOWN' | 'READY' | 'UNAVAILABLE';
export type BrowserFailureClass =
  | 'BROWSER_BINARY_MISSING'
  | 'BROWSER_LINUX_DEPENDENCY_MISSING'
  | 'BROWSER_PERMISSION_DENIED'
  | 'BROWSER_LAUNCH_FAILED';

export interface BrowserExecutableProbe {
  pathClass: 'PLAYWRIGHT_LOCAL_BROWSER' | 'PLAYWRIGHT_MANAGED_BROWSER';
  exists: boolean;
  mode?: string;
  ownerUid?: number;
  ownerGid?: number;
  readableByProcess?: boolean;
  executableByProcess?: boolean;
  probeErrorCode?: 'EACCES' | 'EPERM' | 'ENOENT' | 'UNKNOWN';
}

export interface BrowserCapabilitySnapshot {
  status: BrowserCapabilityStatus;
  checkedAt?: string;
  browserVersion?: string;
  failureClass?: BrowserFailureClass;
  probeStartedAt?: string;
  probeFinishedAt?: string;
  probeDurationMs?: number;
  consecutiveFailures: number;
  lastSuccessAt?: string;
  lastFailureAt?: string;
  attestation: 'CHROMIUM_LAUNCH_CLOSE';
  probeInFlight?: boolean;
  runtimeUid?: number;
  runtimeGid?: number;
  executableProbe?: BrowserExecutableProbe;
  launchErrorCode?: 'EACCES' | 'EPERM' | 'ENOENT' | 'UNKNOWN';
}

export const BROWSER_RUNTIME_UNAVAILABLE = 'BROWSER_RUNTIME_UNAVAILABLE';

// Keep install-time and runtime resolution identical in Railway/Nixpacks images.
if (process.env.PLAYWRIGHT_BROWSERS_PATH !== '0') process.env.PLAYWRIGHT_BROWSERS_PATH = '0';

export function browserLaunchOptions(): { headless: true; args?: string[] } {
  return process.getuid?.() === 0
    ? { headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] }
    : { headless: true };
}

let snapshot: BrowserCapabilitySnapshot = {
  status: 'UNKNOWN',
  consecutiveFailures: 0,
  attestation: 'CHROMIUM_LAUNCH_CLOSE'
};
let activeProbe: Promise<BrowserCapabilitySnapshot> | undefined;

type BrowserCapabilityDiagnostics = Pick<BrowserCapabilitySnapshot, 'runtimeUid' | 'runtimeGid' | 'executableProbe' | 'launchErrorCode'>;

function safeErrorCode(error: unknown): BrowserCapabilitySnapshot['launchErrorCode'] {
  const value = error && typeof error === 'object' ? error as { code?: unknown; cause?: unknown } : undefined;
  const code = String(value?.code || (value?.cause && typeof value.cause === 'object' ? (value.cause as { code?: unknown }).code : '') || '').toUpperCase();
  return code === 'EACCES' || code === 'EPERM' || code === 'ENOENT' ? code : 'UNKNOWN';
}

export async function inspectBrowserExecutable(executablePath: string): Promise<BrowserExecutableProbe> {
  const probe: BrowserExecutableProbe = {
    pathClass: process.env.PLAYWRIGHT_BROWSERS_PATH === '0' ? 'PLAYWRIGHT_LOCAL_BROWSER' : 'PLAYWRIGHT_MANAGED_BROWSER',
    exists: false,
  };
  try {
    const details = await stat(executablePath);
    probe.exists = details.isFile();
    probe.mode = (details.mode & 0o777).toString(8).padStart(3, '0');
    probe.ownerUid = details.uid;
    probe.ownerGid = details.gid;
  } catch (error) {
    probe.probeErrorCode = safeErrorCode(error) || 'UNKNOWN';
    return probe;
  }
  try { await access(executablePath, fsConstants.R_OK); probe.readableByProcess = true; } catch { probe.readableByProcess = false; }
  try { await access(executablePath, fsConstants.X_OK); probe.executableByProcess = true; } catch { probe.executableByProcess = false; }
  return probe;
}

function errorText(error: unknown, seen = new Set<unknown>()): string {
  if (error && typeof error === 'object') {
    if (seen.has(error)) return '';
    seen.add(error);
    const value = error as { message?: unknown; cause?: unknown };
    return `${String(value.message || '')} ${errorText(value.cause, seen)}`.toLowerCase();
  }
  return String(error || '').toLowerCase();
}

export function isBrowserRuntimeFailure(error: unknown): boolean {
  const text = errorText(error);
  if (/page\.goto|navigation|timed? ?out|net::err|response status/.test(text)) return false;
  return /executable doesn't exist|browser executable|cannot find chromium|no executable|shared library|libnss|libgbm|libatk|eacces|permission denied|sandbox.*(root|setuid|namespace)|browsertype\.launch|failed to launch browser|browser process exited/.test(text);
}

export function classifyBrowserFailure(error: unknown): BrowserFailureClass {
  const text = errorText(error);
  if (text.includes('executable doesn\'t exist') || text.includes('browser executable') || text.includes('cannot find chromium') || text.includes('no executable')) {
    return 'BROWSER_BINARY_MISSING';
  }
  if (text.includes('shared library') || text.includes('libnss') || text.includes('libgbm') || text.includes('libatk') || text.includes('error while loading')) {
    return 'BROWSER_LINUX_DEPENDENCY_MISSING';
  }
  if (text.includes('permission denied') || text.includes('eacces') || (text.includes('sandbox') && (text.includes('root') || text.includes('setuid') || text.includes('namespace')))) {
    return 'BROWSER_PERMISSION_DENIED';
  }
  return 'BROWSER_LAUNCH_FAILED';
}

export function browserCapabilitySnapshot(): BrowserCapabilitySnapshot {
  return { ...snapshot, probeInFlight: Boolean(activeProbe) };
}

export function browserCapabilityIsUnavailable(): boolean {
  return snapshot.status === 'UNAVAILABLE';
}

export function markBrowserCapabilityReady(browserVersion?: string, diagnostics: BrowserCapabilityDiagnostics = {}): BrowserCapabilitySnapshot {
  const now = new Date().toISOString();
  snapshot = {
    ...snapshot,
    status: 'READY',
    checkedAt: now,
    browserVersion: browserVersion || undefined,
    failureClass: undefined,
    consecutiveFailures: 0,
    lastSuccessAt: now,
    attestation: 'CHROMIUM_LAUNCH_CLOSE',
    ...diagnostics,
    launchErrorCode: undefined,
  };
  return browserCapabilitySnapshot();
}

export function markBrowserCapabilityUnavailable(error: unknown, diagnostics: BrowserCapabilityDiagnostics = {}): BrowserCapabilitySnapshot {
  const now = new Date().toISOString();
  snapshot = {
    ...snapshot,
    status: 'UNAVAILABLE',
    checkedAt: now,
    failureClass: classifyBrowserFailure(error),
    consecutiveFailures: snapshot.consecutiveFailures + 1,
    lastFailureAt: now,
    attestation: 'CHROMIUM_LAUNCH_CLOSE',
    ...diagnostics,
    launchErrorCode: diagnostics.launchErrorCode || safeErrorCode(error),
  };
  return browserCapabilitySnapshot();
}

export async function probeBrowserCapability(): Promise<BrowserCapabilitySnapshot> {
  if (activeProbe) {
    await activeProbe;
    return { ...browserCapabilitySnapshot(), probeInFlight: false };
  }
  const startedAt = Date.now();
  const startedIso = new Date(startedAt).toISOString();
  const runtimeUid = process.getuid?.();
  const runtimeGid = process.getgid?.();
  let executableProbe: BrowserExecutableProbe | undefined;
  snapshot = { ...snapshot, probeStartedAt: startedIso, probeInFlight: true, runtimeUid, runtimeGid };
  activeProbe = (async () => {
    try {
      const { chromium } = await import('playwright');
      executableProbe = await inspectBrowserExecutable(chromium.executablePath());
      const browser = await chromium.launch(browserLaunchOptions());
      const version = browser.version();
      await browser.close();
      const result = markBrowserCapabilityReady(version, { runtimeUid, runtimeGid, executableProbe });
      snapshot = { ...result, probeFinishedAt: new Date().toISOString(), probeDurationMs: Date.now() - startedAt };
      return browserCapabilitySnapshot();
    } catch (error) {
      const result = markBrowserCapabilityUnavailable(error, { runtimeUid, runtimeGid, executableProbe, launchErrorCode: safeErrorCode(error) });
      snapshot = { ...result, probeFinishedAt: new Date().toISOString(), probeDurationMs: Date.now() - startedAt };
      return browserCapabilitySnapshot();
    }
  })();
  try {
    await activeProbe;
    return { ...browserCapabilitySnapshot(), probeInFlight: false };
  } finally {
    activeProbe = undefined;
  }
}

export function startBrowserCapabilityMonitor(intervalMs = 60_000): () => void {
  let stopped = false;
  const check = async () => {
    if (stopped) return;
    await probeBrowserCapability();
  };
  void check();
  const timer = setInterval(() => {
    void check();
  }, Math.max(30_000, intervalMs));
  timer.unref?.();
  return () => {
    stopped = true;
    clearInterval(timer);
  };
}
