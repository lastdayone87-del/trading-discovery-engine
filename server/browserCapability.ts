export type BrowserCapabilityStatus = 'UNKNOWN' | 'READY' | 'UNAVAILABLE';
export type BrowserFailureClass =
  | 'BROWSER_BINARY_MISSING'
  | 'BROWSER_LINUX_DEPENDENCY_MISSING'
  | 'BROWSER_PERMISSION_DENIED'
  | 'BROWSER_LAUNCH_FAILED';

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

export function markBrowserCapabilityReady(browserVersion?: string): BrowserCapabilitySnapshot {
  const now = new Date().toISOString();
  snapshot = {
    ...snapshot,
    status: 'READY',
    checkedAt: now,
    browserVersion: browserVersion || undefined,
    failureClass: undefined,
    consecutiveFailures: 0,
    lastSuccessAt: now,
    attestation: 'CHROMIUM_LAUNCH_CLOSE'
  };
  return browserCapabilitySnapshot();
}

export function markBrowserCapabilityUnavailable(error: unknown): BrowserCapabilitySnapshot {
  const now = new Date().toISOString();
  snapshot = {
    ...snapshot,
    status: 'UNAVAILABLE',
    checkedAt: now,
    failureClass: classifyBrowserFailure(error),
    consecutiveFailures: snapshot.consecutiveFailures + 1,
    lastFailureAt: now,
    attestation: 'CHROMIUM_LAUNCH_CLOSE'
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
  snapshot = { ...snapshot, probeStartedAt: startedIso, probeInFlight: true };
  activeProbe = (async () => {
    try {
      const { chromium } = await import('playwright');
      const browser = await chromium.launch(browserLaunchOptions());
      const version = browser.version();
      await browser.close();
      const result = markBrowserCapabilityReady(version);
      snapshot = { ...result, probeFinishedAt: new Date().toISOString(), probeDurationMs: Date.now() - startedAt };
      return browserCapabilitySnapshot();
    } catch (error) {
      const result = markBrowserCapabilityUnavailable(error);
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
