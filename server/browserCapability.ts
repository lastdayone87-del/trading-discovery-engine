import { chromium } from 'playwright';

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

let snapshot: BrowserCapabilitySnapshot = { status: 'UNKNOWN' };

function errorText(error: unknown): string {
  return String(error instanceof Error ? error.message : error || '').toLowerCase();
}

export function classifyBrowserFailure(error: unknown): BrowserFailureClass {
  const text = errorText(error);
  if (text.includes('executable doesn\'t exist') || text.includes('browser executable') || text.includes('cannot find chromium') || text.includes('no executable')) {
    return 'BROWSER_BINARY_MISSING';
  }
  if (text.includes('shared library') || text.includes('libnss') || text.includes('libgbm') || text.includes('libatk') || text.includes('error while loading')) {
    return 'BROWSER_LINUX_DEPENDENCY_MISSING';
  }
  if (text.includes('permission denied') || text.includes('eacces') || text.includes('sandbox') && text.includes('root')) {
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
    const browser = await chromium.launch({ headless: true });
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
