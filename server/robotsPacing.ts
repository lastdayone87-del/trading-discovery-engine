/**
 * Process-wide Crawl-delay pacing.
 *
 * Robots Crawl-delay is a property of the origin, not of one inspection.
 * Concurrent inspections must therefore share the last-request clock and
 * serialize their wait windows; a per-crawl map lets two workers sleep
 * independently and then fetch together.
 *
 * Callers pass their own per-crawl delay budget so one site cannot consume the
 * whole inspection budget. Queue time and the sleep both count against it; a
 * caller that cannot acquire its slot within the remaining budget is skipped.
 */

const lastRequestAt = new Map<string, number>();
const originTails = new Map<string, Promise<void>>();
const MAX_TRACKED_ORIGINS = 4_096;

export interface RobotsPacingBudget {
  spentMs: number;
}

function pruneIdleOrigins(now: number): void {
  if (lastRequestAt.size <= MAX_TRACKED_ORIGINS) return;
  for (const [origin, at] of lastRequestAt) {
    if (!originTails.has(origin) && now - at > 60_000) lastRequestAt.delete(origin);
  }
  while (lastRequestAt.size > MAX_TRACKED_ORIGINS) {
    let removed = false;
    for (const origin of lastRequestAt.keys()) {
      if (originTails.has(origin)) continue;
      lastRequestAt.delete(origin);
      removed = true;
      break;
    }
    if (!removed) break;
  }
}

export async function paceRobotsOrigin(
  origin: string,
  delayMs: number,
  budget: RobotsPacingBudget,
  maxBudgetMs = 10_000,
): Promise<boolean> {
  if (!origin || delayMs <= 0) return true;
  if (budget.spentMs >= maxBudgetMs) return false;
  const queuedAt = Date.now();
  const prior = originTails.get(origin) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const tail = prior.then(() => gate);
  originTails.set(origin, tail);
  const remaining = maxBudgetMs - budget.spentMs;
  let queueTimer: ReturnType<typeof setTimeout> | undefined;
  const acquired = remaining <= 0
    ? false
    : await Promise.race([
        prior.then(() => true),
        new Promise<false>(resolve => {
          queueTimer = setTimeout(() => resolve(false), remaining);
        }),
      ]);
  if (queueTimer) clearTimeout(queueTimer);
  if (!acquired) {
    // Do not hold this caller on a busy origin, but release the gate once the
    // prior holder finishes so later callers are not permanently blocked.
    prior.finally(() => {
      release();
      if (originTails.get(origin) === tail) originTails.delete(origin);
    });
    return false;
  }
  budget.spentMs += Date.now() - queuedAt;
  try {
    if (budget.spentMs >= maxBudgetMs) return false;
    const now = Date.now();
    const last = lastRequestAt.get(origin) || 0;
    const wait = Math.max(0, Math.min(delayMs, last + delayMs - now));
    if (wait > 0) {
      if (budget.spentMs + wait > maxBudgetMs) return false;
      budget.spentMs += wait;
      await new Promise(resolve => setTimeout(resolve, wait));
    }
    lastRequestAt.set(origin, Date.now());
    pruneIdleOrigins(Date.now());
    return true;
  } finally {
    release();
    if (originTails.get(origin) === tail) originTails.delete(origin);
  }
}
