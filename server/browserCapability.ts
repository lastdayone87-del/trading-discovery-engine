import { constants as fsConstants, readFileSync } from 'node:fs';
import { access, stat } from 'node:fs/promises';

export type BrowserCapabilityStatus = 'UNKNOWN' | 'READY' | 'UNAVAILABLE';
const DEFAULT_BROWSER_LAUNCH_TIMEOUT_MS = 15_000;
const MIN_BROWSER_LAUNCH_TIMEOUT_MS = 5_000;
const MAX_BROWSER_LAUNCH_TIMEOUT_MS = 30_000;
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

// Honor the runtime image's configured browser path. Railway's pinned Playwright image
// uses /ms-playwright; local/Nixpacks setups may explicitly use PLAYWRIGHT_BROWSERS_PATH=0.
// Do not overwrite either choice before importing Playwright.

export function browserLaunchOptions(): { headless: true; args: string[]; timeout: number } {
  const configuredTimeout = Number(process.env.BROWSER_LAUNCH_TIMEOUT_MS);
  const timeout = Number.isFinite(configuredTimeout)
    ? Math.min(MAX_BROWSER_LAUNCH_TIMEOUT_MS, Math.max(MIN_BROWSER_LAUNCH_TIMEOUT_MS, Math.floor(configuredTimeout)))
    : DEFAULT_BROWSER_LAUNCH_TIMEOUT_MS;
  // Railway containers can expose a small /dev/shm. Keep the capability attestation
  // on the same resilient Chromium launch path used by the crawler instead of allowing
  // the health probe to fail solely because Chromium's shared-memory segment is full.
  const args: string[] = [];
  if (process.getuid?.() === 0) {
    args.push('--no-sandbox', '--disable-setuid-sandbox');
  }
  args.push('--disable-dev-shm-usage');
  return { headless: true, timeout, args };
}

let snapshot: BrowserCapabilitySnapshot = {
  status: 'UNKNOWN',
  consecutiveFailures: 0,
  attestation: 'CHROMIUM_LAUNCH_CLOSE'
};
let activeProbe: Promise<BrowserCapabilitySnapshot> | undefined;
const DEFAULT_BROWSER_RUNTIME_CONCURRENCY = 1;
const MAX_BROWSER_RUNTIME_CONCURRENCY = 2;

/**
 * Configured browser slot count (1..2), read once at module load. Exported so
 * downstream gates can default to the same slot budget instead of pinning a
 * separate copy of the number — the rendered-crawl gate derives its
 * concurrency from this so the lease and the gate can never disagree.
 */
export function browserRuntimeConcurrency(): number {
  const parsed = Number(process.env.BROWSER_RUNTIME_CONCURRENCY);
  if (!Number.isFinite(parsed)) return DEFAULT_BROWSER_RUNTIME_CONCURRENCY;
  return Math.min(MAX_BROWSER_RUNTIME_CONCURRENCY, Math.max(1, Math.floor(parsed)));
}

let browserRuntimeLimit = browserRuntimeConcurrency();
let browserRuntimeActive = 0;
const browserRuntimeWaiters: Array<() => void> = [];

/**
 * Resource safety for the multi-slot browser lease (rendered-capacity Fix B).
 * A second browser slot is only worth opening while the memory actually
 * available to THIS container has room for another Chromium. Two ceilings
 * apply: the host's `MemAvailable` (`/proc/meminfo` is not namespaced, so it
 * reflects the VPS the container runs on) and, when a cgroup memory limit is
 * configured, the container's own headroom (`memory.max` minus
 * `memory.current`). The guard is re-evaluated on every acquire and release:
 * a degraded host falls back to single-slot behavior for NEW launches, and
 * the browser already running is never killed.
 *
 * The reader is injectable so capacity tests can simulate host memory without
 * touching the real /proc and cgroup filesystems.
 */
const DEFAULT_EXTRA_SLOT_MIN_HOST_MEM_MB = 1_500;
function readMemoryFileMb(filePath: string): number | null {
  try {
    const content = readFileSync(filePath, 'utf8').trim();
    // /proc/meminfo lines carry a kB suffix; cgroup v2 files carry plain bytes
    // and the literal "max" for unbounded.
    if (content.endsWith('kB')) return Math.floor(Number(content.replace(/kB$/, '').trim()) / 1024);
    if (content === 'max' || content === '') return null;
    const bytes = Number(content);
    return Number.isFinite(bytes) ? Math.floor(bytes / (1024 * 1024)) : null;
  } catch {
    return null;
  }
}
interface MemoryHeadroomReader {
  /** Host MemAvailable in MB, or null when unreadable. */
  host: () => number | null;
  /** Container cgroup memory.max in MB, or null when unbounded/unreadable. */
  containerLimit: () => number | null;
  /** Container cgroup memory.current in MB, or null when unreadable. */
  containerUsage: () => number | null;
}
const productionMemoryHeadroomReader: MemoryHeadroomReader = {
  host: () => {
    try {
      const match = readFileSync('/proc/meminfo', 'utf8').match(/^MemAvailable:\s+(\d+)\s*kB/m);
      return match ? Math.floor(Number(match[1]) / 1024) : null;
    } catch {
      return null;
    }
  },
  containerLimit: () => readMemoryFileMb('/sys/fs/cgroup/memory.max'),
  containerUsage: () => readMemoryFileMb('/sys/fs/cgroup/memory.current'),
};
let headroomReader: MemoryHeadroomReader = productionMemoryHeadroomReader;
/** Test seam: replace the memory readers (pass the previous value to restore). */
export function setMemoryHeadroomReaderForTests(reader: Partial<MemoryHeadroomReader>): MemoryHeadroomReader {
  const previous = headroomReader;
  headroomReader = { ...previous, ...reader };
  return previous;
}
/**
 * Memory available for one more browser, in MB, or null when the guard must
 * not grant an extra slot (below threshold, or host telemetry unreadable).
 * When a cgroup memory limit is configured, the container's own headroom
 * (limit − usage) caps the effective value.
 */
export function hostMemAvailableForExtraSlot(): number | null {
  const hostAvailableMb = headroomReader.host();
  if (hostAvailableMb === null) return null;
  let effective = hostAvailableMb;
  const containerLimitMb = headroomReader.containerLimit();
  if (containerLimitMb !== null) {
    const containerUsageMb = headroomReader.containerUsage() ?? 0;
    effective = Math.min(effective, Math.max(0, containerLimitMb - containerUsageMb));
  }
  const threshold = Number(process.env.BROWSER_EXTRA_SLOT_MIN_HOST_MEM_MB);
  const minMb = Number.isFinite(threshold) && threshold > 0 ? threshold : DEFAULT_EXTRA_SLOT_MIN_HOST_MEM_MB;
  return effective >= minMb ? effective : null;
}

/** Test seam: override the configured browser slot count (returns the previous value). */
export function setBrowserRuntimeLimitForTests(limit: number): number {
  const previous = browserRuntimeLimit;
  browserRuntimeLimit = limit;
  return previous;
}

/**
 * Effective slot count for this acquire attempt. Slot one is always allowed —
 * a single browser must remain possible even on a degraded host. Slots beyond
 * one require memory headroom (host and, when applicable, cgroup); unreadable
 * host telemetry fails open so an operator-configured limit is never bricked
 * by a telemetry hiccup. Reads the host value exactly once per call.
 */
function effectiveRuntimeLimit(): number {
  if (browserRuntimeLimit <= 1) return 1;
  const hostAvailableMb = headroomReader.host();
  // Unreadable telemetry fails open to the configured limit; only a readable
  // below-threshold value closes the extra slots.
  if (hostAvailableMb === null) return browserRuntimeLimit;
  return hostMemAvailableForExtraSlot() === null ? 1 : browserRuntimeLimit;
}

function acquireBrowserRuntimeLease(): Promise<() => void> {
  const grant = (): (() => void) => {
    browserRuntimeActive++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      browserRuntimeActive--;
      // Recheck the resource guard before promoting a queued waiter: memory
      // may have degraded while both slots ran. When the effective limit no
      // longer admits a new launch, the waiter stays queued for a later
      // release — slot one always becomes possible once active hits zero,
      // so a queued waiter can never be stranded.
      if (browserRuntimeActive < effectiveRuntimeLimit()) {
        const next = browserRuntimeWaiters.shift();
        if (next) next();
      }
    };
  };
  if (browserRuntimeActive < effectiveRuntimeLimit()) return Promise.resolve(grant());
  return new Promise<() => void>(resolve => {
    browserRuntimeWaiters.push(() => resolve(grant()));
  });
}

/**
 * Bound attestation and real crawler browser launches to the measured number
 * of browser slots. The default remains one for existing deployments; an
 * operator can enable a second slot via BROWSER_RUNTIME_CONCURRENCY, and the
 * resource-safety guard above keeps that slot closed whenever the host lacks
 * the memory headroom to hold another Chromium.
 */
export async function withBrowserRuntimeLease<T>(operation: () => Promise<T>): Promise<T> {
  const release = await acquireBrowserRuntimeLease();
  try {
    return await operation();
  } finally {
    release();
  }
}

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
  // Launch-marker carve-out first: a timeout explicitly associated with
  // browser startup (e.g. "browserType.launch: Timeout 15000ms exceeded") is
  // a browser runtime failure, not a navigation/request timeout. Only texts
  // without any launch marker fall through to the timeout exclusion below.
  if (/browsertype\.launch|failed to launch browser|browser process exited/.test(text)) return true;
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
      const version = await withBrowserRuntimeLease(async () => {
        const browser = await chromium.launch(browserLaunchOptions());
        try {
          return browser.version();
        } finally {
          await browser.close();
        }
      });
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
  let timer: NodeJS.Timeout | undefined;
  const healthyIntervalMs = Math.max(30_000, intervalMs);
  const degradedIntervalMs = Math.max(30_000, Math.min(healthyIntervalMs, 30_000));
  const check = async (): Promise<void> => {
    if (stopped) return;
    const result = await probeBrowserCapability();
    if (stopped) return;
    const nextIntervalMs = result.status === 'READY' ? healthyIntervalMs : degradedIntervalMs;
    timer = setTimeout(() => { void check(); }, nextIntervalMs);
    timer.unref?.();
  };
  void check();
  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
  };
}