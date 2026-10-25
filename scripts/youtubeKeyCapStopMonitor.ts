/**
 * Durable YouTube per-key cap stop monitor.
 *
 * This replaces the log-derived refusal count with the persisted counter from
 * migration 158. A restart, a Docker log rotation, or a crash between the
 * refusal and the log flush no longer hides a cap storm.
 *
 * Usage (inside the application environment, where DATABASE_URL is set):
 *
 *   MONITOR_ONCE=1 npx tsx scripts/youtubeKeyCapStopMonitor.ts
 *   END_EPOCH=1793036400 MONITOR_SINCE_EPOCH=1792998000 ALERT_ONLY=1 \
 *     npx tsx scripts/youtubeKeyCapStopMonitor.ts
 *
 * MONITOR_SINCE_EPOCH is the reset epoch. It bounds the rolling secondary
 * signals so quota-blocked jobs from before the reset cannot stop the first
 * post-reset sample. A reset epoch in the future is treated as inactive. The
 * start of the current Pacific quota day is always an additional lower bound,
 * so a fixed epoch cannot carry yesterday's failures into a later day.
 *
 * The monitor is deliberately conservative: if it cannot read the durable
 * counter or the health endpoint twice in a row, it stops rather than assuming
 * the cap path is healthy. ALERT_ONLY=1 logs the same failures and continues;
 * it never writes a stop marker or a durable stop row.
 *
 * The /tmp stop and state files are caches. The durable per-day stop table
 * (migration 159) recreates a cap stop after a container replacement.
 */
import dotenv from 'dotenv';
dotenv.config();
import {
  appendFileSync,
  existsSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { getDb } from '../server/db';
import { getYouTubeQuotaDay, getYouTubeQuotaDayStartAt } from '../server/youtubeQuotaDay';
import {
  KEY_CAP_REFUSAL_EVENT_PRUNE_BATCH,
  KEY_CAP_REFUSAL_EVENT_PRUNE_MAX_BATCHES,
  KEY_CAP_REFUSAL_EVENT_RETENTION_DAYS,
  logKeyCapRefusalAccountingFailure,
  pruneYouTubeKeyCapRefusalEvents,
  readYouTubeKeyCapRefusalSummary,
} from '../server/quotaKeyCapRefusals';
import { readYouTubeKeyCapSecondarySignals } from '../server/youtubeKeyCapSecondarySignals';
import {
  readKeyCapMonitorStop,
  recordKeyCapMonitorStopWithRetry,
  type KeyCapMonitorStop,
} from '../server/youtubeKeyCapMonitorStops';
import {
  evaluateDurableKeyCapMonitorSample,
  formatKeyCapStopMarker,
  keyCapStopMarkerQuotaDay,
  monitorSecondaryWindowStart,
  shouldClearPriorDayStopMarkerForSample,
  shouldWriteStopMarker,
  stateForAlertOnlySample,
  stopAlreadyPersistedForQuotaDay,
  type KeyCapMonitorState,
} from '../server/youtubeKeyCapStopRule';

const STOP_FILE = process.env.YOUTUBE_KEY_CAP_MONITOR_STOP_FILE || '/tmp/youtube-key-cap-stop.txt';
const STATE_FILE = process.env.YOUTUBE_KEY_CAP_MONITOR_STATE_FILE || '/tmp/youtube-key-cap-monitor-state.json';
const LOG_FILE = process.env.YOUTUBE_KEY_CAP_MONITOR_LOG || '/tmp/youtube-key-cap-monitor.csv';
const INTERVAL_MS = Math.max(5_000, Number(process.env.YOUTUBE_KEY_CAP_MONITOR_INTERVAL_MS) || 60_000);
const END_EPOCH = Number(process.env.END_EPOCH) || 0;
const ALERT_ONLY = process.env.ALERT_ONLY === '1';
const ONCE = process.env.MONITOR_ONCE === '1';
const SINCE_EPOCH = Number(process.env.MONITOR_SINCE_EPOCH) || 0;
const HEALTH_URL = process.env.APP_HEALTH_URL || 'http://127.0.0.1:3000/api/health';
const MAX_SEARCH_PENDING = Number(process.env.MONITOR_MAX_SEARCH_PENDING) || 75;
const MAX_ENRICH_PENDING = Number(process.env.MONITOR_MAX_ENRICH_PENDING) || 450;
const RETENTION_DAYS = Math.max(
  1,
  Number(process.env.YOUTUBE_KEY_CAP_REFUSAL_RETENTION_DAYS) || KEY_CAP_REFUSAL_EVENT_RETENTION_DAYS,
);
const PRUNE_INTERVAL_MS = 60 * 60_000;

type MonitorDb = Awaited<ReturnType<typeof getDb>>;

interface QueueSample {
  searchPending: number;
  enrichPending: number;
}

interface SecondarySignals {
  capUnavailable: number;
  quotaExhausted: number;
}

interface MonitorSample {
  quotaDay: string;
  capExceeded: number;
  secondary: SecondarySignals;
  queue: QueueSample;
  health: { http: number; ready: boolean };
  durableStop: KeyCapMonitorStop | null;
}

function readState(): KeyCapMonitorState | null {
  try {
    const parsed = JSON.parse(readFileSync(STATE_FILE, 'utf8'));
    if (!parsed || typeof parsed !== 'object') return null;
    return {
      quotaDay: String(parsed.quotaDay || ''),
      capExceeded: Number(parsed.capExceeded) || 0,
      stopReason: parsed.stopReason || null,
      stopAt: parsed.stopAt || null,
    };
  } catch {
    return null;
  }
}

function writeAtomic(path: string, content: string): void {
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, content, { mode: 0o600 });
  renameSync(tmp, path);
}

function writeStop(reason: string, detail: string, now: Date, quotaDay: string): void {
  writeAtomic(STOP_FILE, formatKeyCapStopMarker({ reason, detail, at: now, quotaDay }));
}

function appendLog(line: string): void {
  try {
    appendFileSync(LOG_FILE, `${line}\n`);
  } catch {
    // The stop file, durable stop row, and DB counter are the safety-critical outputs.
  }
}

function readStopMarkerDay(): string | null {
  try {
    if (!existsSync(STOP_FILE)) return null;
    return keyCapStopMarkerQuotaDay(readFileSync(STOP_FILE, 'utf8'));
  } catch {
    return null;
  }
}

function clearPriorDayStopFile(currentQuotaDay: string, sampleHealthy: boolean): void {
  try {
    if (!existsSync(STOP_FILE)) return;
    const content = readFileSync(STOP_FILE, 'utf8');
    if (!shouldClearPriorDayStopMarkerForSample({
      content,
      currentQuotaDay,
      alertOnly: ALERT_ONLY,
      sampleHealthy,
    })) return;
    unlinkSync(STOP_FILE);
    appendLog(`${new Date().toISOString()}|STOP_FILE_CLEARED|prior_day|${currentQuotaDay}`);
  } catch (error) {
    appendLog(
      `${new Date().toISOString()}|STOP_FILE_CLEAR_FAILED|${String((error as Error)?.message || error).slice(0, 200)}`,
    );
  }
}

async function readDatabaseNow(db: MonitorDb): Promise<Date> {
  const result = await db.query('SELECT now() AS now');
  const value = result.rows[0]?.now;
  const date = value instanceof Date ? value : new Date(String(value || ''));
  if (!Number.isFinite(date.getTime())) throw new Error('database clock unavailable');
  return date;
}

async function readQueue(db: MonitorDb): Promise<QueueSample> {
  const result = await db.query(
    `SELECT
       COUNT(*) FILTER (WHERE type='SEARCH_YOUTUBE' AND status='PENDING')::int AS search_pending,
       COUNT(*) FILTER (WHERE type='ENRICH_CHANNEL' AND status='PENDING')::int AS enrich_pending
     FROM jobs`,
  );
  return {
    searchPending: Number(result.rows[0]?.search_pending) || 0,
    enrichPending: Number(result.rows[0]?.enrich_pending) || 0,
  };
}

async function readHealth(): Promise<{ http: number; ready: boolean }> {
  try {
    const response = await fetch(HEALTH_URL, { signal: AbortSignal.timeout(5_000) });
    const body = await response.text();
    return {
      http: response.status,
      ready: response.ok && /"readiness"\s*:\s*"ready"/.test(body),
    };
  } catch {
    return { http: 0, ready: false };
  }
}

async function readSecondarySignals(
  db: MonitorDb,
  nowMs: number,
  quotaDayStartMs: number,
): Promise<SecondarySignals> {
  return readYouTubeKeyCapSecondarySignals(
    db,
    monitorSecondaryWindowStart(nowMs, SINCE_EPOCH, quotaDayStartMs),
  );
}

/**
 * Read one consistent sample. If the Pacific day changes while the reads are
 * in flight, discard the old-day snapshot and read again for the new day; a
 * pre-midnight durable total must never be persisted as a post-midnight stop.
 */
async function sampleOnce(db: MonitorDb, attempt = 0): Promise<MonitorSample> {
  // Use the database clock for the Pacific quota day. The host and database can
  // disagree around midnight; deriving the day from the host would read the
  // wrong durable counter and could persist a pre-reset total as a new stop.
  const dbNow = await readDatabaseNow(db);
  const startedDay = getYouTubeQuotaDay(dbNow);
  const summary = await readYouTubeKeyCapRefusalSummary(db, startedDay);
  const [secondary, queue, health, durableStop] = await Promise.all([
    readSecondarySignals(db, dbNow.getTime(), getYouTubeQuotaDayStartAt(dbNow)),
    readQueue(db),
    readHealth(),
    readKeyCapMonitorStop(db, startedDay),
  ]);
  const endDbNow = await readDatabaseNow(db);
  if (getYouTubeQuotaDay(endDbNow) !== startedDay) {
    if (attempt >= 1) throw new Error('quota day changed repeatedly during monitor sample');
    return sampleOnce(db, attempt + 1);
  }
  return {
    quotaDay: startedDay,
    capExceeded: summary.refusals,
    secondary,
    queue,
    health,
    durableStop,
  };
}

const alertedKinds = new Set<string>();

function appendAlertOnce(kind: string, now: Date, detail: string): void {
  if (alertedKinds.has(kind)) return;
  alertedKinds.add(kind);
  appendLog(`${now.toISOString()}|ALERT_ONLY|${kind}|${detail}`);
}

function clearAlert(kind: string): void {
  alertedKinds.delete(kind);
}

async function main(): Promise<void> {
  const db = await getDb();
  let state = readState();
  let healthFailures = 0;
  let queueFailures = 0;
  let sampleFailures = 0;
  let lastPruneMs = 0;

  for (;;) {
    const now = new Date();
    if (END_EPOCH > 0 && Math.floor(now.getTime() / 1000) >= END_EPOCH) {
      appendLog(`${now.toISOString()}|COMPLETE`);
      return;
    }

    let sample: MonitorSample;
    try {
      sample = await sampleOnce(db);
      sampleFailures = 0;
      clearAlert('SAMPLE_FAILURE');
    } catch (error) {
      sampleFailures += 1;
      appendLog(`${now.toISOString()}|SAMPLE_ERROR|${String((error as Error)?.message || error).slice(0, 200)}`);
      if (sampleFailures >= 2) {
        if (ALERT_ONLY) {
          appendAlertOnce('SAMPLE_FAILURE', now, 'durable counter or database read failed twice');
        } else {
          writeStop('MONITOR_UNAVAILABLE', 'durable counter or database read failed twice', now, '');
          process.exit(2);
        }
      }
      await new Promise(resolve => setTimeout(resolve, INTERVAL_MS));
      continue;
    }

    // A durable stop recorded before a container replacement is authoritative.
    // Merge it before evaluation so the restarted monitor recreates the stop
    // file and exits instead of trusting a decayed rolling window.
    if (sample.durableStop && (state?.quotaDay !== sample.quotaDay || !state?.stopReason)) {
      state = {
        quotaDay: sample.quotaDay,
        capExceeded: state?.quotaDay === sample.quotaDay ? state.capExceeded : 0,
        stopReason: sample.durableStop.reason,
        stopAt: sample.durableStop.stoppedAt,
      };
    }

    const stopAlreadyPersisted = stopAlreadyPersistedForQuotaDay(state, sample.quotaDay);
    const evaluation = evaluateDurableKeyCapMonitorSample(
      state,
      {
        quotaDay: sample.quotaDay,
        capExceeded: sample.capExceeded,
        capUnavailable: sample.secondary.capUnavailable,
        quotaExhausted: sample.secondary.quotaExhausted,
      },
      now,
    );
    state = evaluation.state;
    if (ALERT_ONLY) state = stateForAlertOnlySample(state, stopAlreadyPersisted);
    writeAtomic(STATE_FILE, `${JSON.stringify(state)}\n`);

    appendLog(
      [
        now.toISOString(),
        sample.quotaDay,
        sample.capExceeded,
        sample.secondary.capUnavailable,
        sample.secondary.quotaExhausted,
        sample.health.http,
        sample.health.ready ? 1 : 0,
        sample.queue.searchPending,
        sample.queue.enrichPending,
        evaluation.verdict.stop ? `STOP:${evaluation.verdict.reason}` : 'OK',
      ].join('|'),
    );

    if (evaluation.verdict.stop) {
      const reason = evaluation.verdict.reason!;
      if (!ALERT_ONLY) {
        // The local marker is the immediate fail-closed signal. Write it
        // before the durable insert so a slow database cannot delay the
        // runner's stop, then retry the durable row for several minutes.
        const markerDay = readStopMarkerDay();
        if (shouldWriteStopMarker({
          alertOnly: false,
          shouldWriteStop: evaluation.shouldWriteStop,
          markerQuotaDay: markerDay,
          currentQuotaDay: sample.quotaDay,
        })) {
          writeStop(reason, evaluation.verdict.detail, now, sample.quotaDay);
        }
        try {
          await recordKeyCapMonitorStopWithRetry(db, {
            quotaDay: sample.quotaDay,
            reason,
            detail: evaluation.verdict.detail,
            at: now,
          }, {
            attempts: 12,
            delayMs: attempt => Math.min(30_000, 1_000 * 2 ** (attempt - 1)),
          });
        } catch (error) {
          logKeyCapRefusalAccountingFailure(error, {
            branch: 'monitor-stop-persist',
            quotaDay: sample.quotaDay,
            reason,
          });
          appendLog(`${now.toISOString()}|STOP_PERSIST_FAILED|${reason}`);
        }
        process.exit(2);
      }
      // Alert-only must not arm or disarm enforcement: no stop file write, no
      // durable stop row, and no removal of an enforcing run's stop marker.
      appendAlertOnce('CAP_STOP', now, `continuing after cap stop ${reason}`);
    } else {
      clearAlert('CAP_STOP');
    }

    // Do not retire yesterday's marker until the whole sample is healthy. If
    // health or queue checks fail, the old stop must stay in place while the
    // two-failure counters escalate; otherwise the runner can resume during
    // the gap, and MONITOR_ONCE could return without a replacement stop.
    let sampleHealthy = true;

    if (!sample.health.ready || sample.health.http !== 200) {
      sampleHealthy = false;
      healthFailures += 1;
      if (healthFailures >= 2) {
        if (ALERT_ONLY) {
          appendAlertOnce('HEALTH_FAILURE', now, `http=${sample.health.http} ready=${sample.health.ready}`);
        } else {
          writeStop('HEALTH_FAILURE', `http=${sample.health.http} ready=${sample.health.ready}`, now, sample.quotaDay);
          process.exit(2);
        }
      }
    } else {
      healthFailures = 0;
      clearAlert('HEALTH_FAILURE');
    }

    if (sample.queue.searchPending > MAX_SEARCH_PENDING || sample.queue.enrichPending > MAX_ENRICH_PENDING) {
      sampleHealthy = false;
      queueFailures += 1;
      if (queueFailures >= 2) {
        if (ALERT_ONLY) {
          appendAlertOnce(
            'QUEUE_GROWTH',
            now,
            `search=${sample.queue.searchPending} enrich=${sample.queue.enrichPending}`,
          );
        } else {
          writeStop(
            'QUEUE_GROWTH',
            `search=${sample.queue.searchPending} enrich=${sample.queue.enrichPending}`,
            now,
            sample.quotaDay,
          );
          process.exit(2);
        }
      }
    } else {
      queueFailures = 0;
      clearAlert('QUEUE_GROWTH');
    }

    // Alert-only must not clear an enforcing run's stop. Only an enforcing
    // sample that passes cap, health, and queue checks retires yesterday's
    // quota marker.
    clearPriorDayStopFile(sample.quotaDay, sampleHealthy);

    if (now.getTime() - lastPruneMs >= PRUNE_INTERVAL_MS) {
      lastPruneMs = now.getTime();
      try {
        const deleted = await pruneYouTubeKeyCapRefusalEvents(db, RETENTION_DAYS);
        if (deleted >= KEY_CAP_REFUSAL_EVENT_PRUNE_BATCH * KEY_CAP_REFUSAL_EVENT_PRUNE_MAX_BATCHES) {
          appendLog(`${now.toISOString()}|REFUSAL_EVENTS_PRUNE_LIMIT_REACHED|${deleted}`);
        } else if (deleted > 0) {
          appendLog(`${now.toISOString()}|REFUSAL_EVENTS_PRUNED|${deleted}`);
        }
      } catch (error) {
        appendLog(
          `${now.toISOString()}|REFUSAL_EVENTS_PRUNE_FAILED|${String((error as Error)?.message || error).slice(0, 200)}`,
        );
      }
    }

    if (ONCE) return;
    await new Promise(resolve => setTimeout(resolve, INTERVAL_MS));
  }
}

main().catch(error => {
  console.error('youtube-key-cap-stop-monitor failed:', error);
  // Database initialization or an unexpected top-level failure can reject
  // before the sampling loop's two-failure escalation. Leave an immediate
  // fail-closed marker unless a more specific stop already exists.
  try {
    if (!existsSync(STOP_FILE)) {
      writeStop(
        'MONITOR_UNAVAILABLE',
        `monitor failed: ${String((error as Error)?.message || error).slice(0, 200)}`,
        new Date(),
        '',
      );
    }
  } catch {
    // The runner still refuses a missing/dead monitor; preserve exit 1.
  }
  process.exit(1);
});
