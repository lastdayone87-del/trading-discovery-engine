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
}

export const BROWSER_RUNTIME_UNAVAILABLE = 'BROWSER_RUNTIME_UNAVAILABLE';

// Keep install-time and runtime resolution identical in Railway/Nixpacks images.
if (process.env.PLAYWRIGHT_BROWSERS_PATH !== '0') process.env.PLAYWRIGHT_BROWSERS_PATH = '0';

export function browserLaunchOptions(): { headless: true; args?: string[] } {
  return process.getuid?.() === 0
    ? { headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] }
    : { headless: true };
}

let snapshot: BrowserCapabilitySnapshot = { status: 'UNKNOWN' };

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
  return { ...snapshot };
}

export function browserCapabilityIsUnavailable(): boolean {
  return snapshot.status === 'UNAVAILABLE';
}

export function markBrowserCapabilityReady(browserVersion?: string): BrowserCapabilitySnapshot {
  snapshot = {
    status: 'READY',
    checkedAt: new Date().toISOString(),
    browserVersion: browserVersion || undefined,
  };
  return browserCapabilitySnapshot();
}

export function markBrowserCapabilityUnavailable(error: unknown): BrowserCapabilitySnapshot {
  snapshot = {
    status: 'UNAVAILABLE',
    checkedAt: new Date().toISOString(),
    failureClass: classifyBrowserFailure(error),
  };
  return browserCapabilitySnapshot();
}

export async function probeBrowserCapability(): Promise<BrowserCapabilitySnapshot> {
  try {
    const { chromium } = await import('playwright');
    const browser = await chromium.launch(browserLaunchOptions());
    const version = browser.version();
    await browser.close();
    return markBrowserCapabilityReady(version);
  } catch (error) {
    return markBrowserCapabilityUnavailable(error);
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
