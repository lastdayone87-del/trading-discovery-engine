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
 * post-reset sample.
 *
 * The monitor is deliberately conservative: if it cannot read the durable
 * counter or the health endpoint twice in a row, it stops rather than assuming
 * the cap path is healthy.
 */
import dotenv from 'dotenv';
dotenv.config();
import { appendFileSync, existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { getDb } from '../server/db';
import { getYouTubeQuotaDay } from '../server/youtubeQuotaDay';
import { readYouTubeKeyCapRefusalSummary } from '../server/quotaKeyCapRefusals';
import {
  evaluateDurableKeyCapMonitorSample,
  monitorSecondaryWindowStart,
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

interface QueueSample {
  searchPending: number;
  enrichPending: number;
}

interface SecondarySignals {
  capUnavailable: number;
  quotaExhausted: number;
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

function writeStop(reason: string, detail: string, now: Date): void {
  writeAtomic(STOP_FILE, `STOP|${reason}|${detail}|${now.toISOString()}\n`);
}

function appendLog(line: string): void {
  try {
    appendFileSync(LOG_FILE, `${line}\n`);
  } catch {
    // The stop file and DB counter are the safety-critical outputs.
  }
}

async function readQueue(): Promise<QueueSample> {
  const db = await getDb();
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

async function readSecondarySignals(): Promise<SecondarySignals> {
  const db = await getDb();
  const windowStart = monitorSecondaryWindowStart(Date.now(), SINCE_EPOCH);
  const result = await db.query(
    `SELECT
       (SELECT COUNT(*) FROM job_attempts
         WHERE finished_at > $1
           AND error LIKE '%YOUTUBE_KEY_CAP_UNAVAILABLE%')::int AS cap_unavailable,
       ((SELECT COUNT(*) FROM job_attempts
          WHERE finished_at > $1
            AND (error LIKE '%QUOTA_ALLOCATION_EXHAUSTED%'
                 OR error LIKE '%quota allocation is exhausted%'))
        + (SELECT COUNT(*) FROM jobs
            WHERE updated_at > $1
              AND last_error LIKE '%quota allocation is exhausted%'))::int AS quota_exhausted`,
    [windowStart],
  );
  return {
    capUnavailable: Number(result.rows[0]?.cap_unavailable) || 0,
    quotaExhausted: Number(result.rows[0]?.quota_exhausted) || 0,
  };
}

async function sampleOnce(): Promise<{
  quotaDay: string;
  capExceeded: number;
  secondary: SecondarySignals;
  queue: QueueSample;
  health: { http: number; ready: boolean };
}> {
  const now = new Date();
  const quotaDay = getYouTubeQuotaDay(now);
  const db = await getDb();
  const summary = await readYouTubeKeyCapRefusalSummary(db, quotaDay);
  const [secondary, queue, health] = await Promise.all([
    readSecondarySignals(),
    readQueue(),
    readHealth(),
  ]);
  return { quotaDay, capExceeded: summary.refusals, secondary, queue, health };
}

async function main(): Promise<void> {
  let state = readState();
  let healthFailures = 0;
  let queueFailures = 0;
  let sampleFailures = 0;
  let alerted = false;

  for (;;) {
    const now = new Date();
    if (END_EPOCH > 0 && Math.floor(now.getTime() / 1000) >= END_EPOCH) {
      appendLog(`${now.toISOString()}|COMPLETE`);
      return;
    }

    let sample: Awaited<ReturnType<typeof sampleOnce>>;
    try {
      sample = await sampleOnce();
      sampleFailures = 0;
    } catch (error) {
      sampleFailures += 1;
      appendLog(`${now.toISOString()}|SAMPLE_ERROR|${String((error as Error)?.message || error).slice(0, 200)}`);
      if (sampleFailures >= 2) {
        writeStop('MONITOR_UNAVAILABLE', 'durable counter or database read failed twice', now);
        process.exit(2);
      }
      await new Promise(resolve => setTimeout(resolve, INTERVAL_MS));
      continue;
    }

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
      if (evaluation.shouldWriteStop || !existsSync(STOP_FILE)) {
        writeStop(String(evaluation.verdict.reason), evaluation.verdict.detail, now);
      }
      if (!ALERT_ONLY) process.exit(2);
      if (!alerted) {
        appendLog(`${now.toISOString()}|ALERT_ONLY|continuing after cap stop`);
        alerted = true;
      }
    }

    if (!sample.health.ready || sample.health.http !== 200) {
      healthFailures += 1;
      if (healthFailures >= 2) {
        writeStop('HEALTH_FAILURE', `http=${sample.health.http} ready=${sample.health.ready}`, now);
        process.exit(2);
      }
    } else {
      healthFailures = 0;
    }

    if (sample.queue.searchPending > MAX_SEARCH_PENDING || sample.queue.enrichPending > MAX_ENRICH_PENDING) {
      queueFailures += 1;
      if (queueFailures >= 2) {
        writeStop(
          'QUEUE_GROWTH',
          `search=${sample.queue.searchPending} enrich=${sample.queue.enrichPending}`,
          now,
        );
        process.exit(2);
      }
    } else {
      queueFailures = 0;
    }

    if (ONCE) return;
    await new Promise(resolve => setTimeout(resolve, INTERVAL_MS));
  }
}

main().catch(error => {
  console.error('youtube-key-cap-stop-monitor failed:', error);
  process.exit(1);
});
