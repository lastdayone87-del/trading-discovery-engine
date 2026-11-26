/**
 * Process-wide Crawl-delay pacing.
 *
 * Robots Crawl-delay is a property of the origin, not of one inspection.
 * Concurrent inspections must therefore share the last-request clock and
 * serialize their wait windows; a per-crawl map lets two workers sleep
 * independently and then fetch together.
 *
 * Callers pass their own per-crawl delay budget so one site cannot consume the
 * whole inspection budget. The budget is advisory: once exhausted the caller
 * skips the request and marks coverage incomplete.
 */

const lastRequestAt = new Map<string, number>();
const originTails = new Map<string, Promise<void>>();

export interface RobotsPacingBudget {
  spentMs: number;
}

export async function paceRobotsOrigin(
  origin: string,
  delayMs: number,
  budget: RobotsPacingBudget,
  maxBudgetMs = 10_000,
): Promise<boolean> {
  if (!origin || delayMs <= 0) return true;
  const prior = originTails.get(origin) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const tail = prior.then(() => gate);
  originTails.set(origin, tail);
  await prior;
  try {
    const now = Date.now();
    const last = lastRequestAt.get(origin) || 0;
    const wait = Math.max(0, Math.min(delayMs, last + delayMs - now));
    if (wait > 0) {
      if (budget.spentMs + wait > maxBudgetMs) return false;
      budget.spentMs += wait;
      await new Promise(resolve => setTimeout(resolve, wait));
    }
    lastRequestAt.set(origin, Date.now());
    return true;
  } finally {
    release();
    if (originTails.get(origin) === tail) originTails.delete(origin);
  }
}
