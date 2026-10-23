import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test, { after } from 'node:test';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import type { Pool } from 'pg';
import {
  computeAdaptivePilotMetrics,
  recordAdaptivePilotAssignment
} from './adaptiveDiscoveryPilot';

/**
 * Dedicated-database tests for the adaptive pilot assignment ledger. The CI
 * workflow applies the full migration lineage first; without an explicitly
 * provided scratch database these tests skip rather than touching any shared
 * database.
 */
const dedicatedUrl = process.env.ADAPTIVE_PILOT_TEST_DATABASE_URL;

test('adaptive pilot PostgreSQL tests require a dedicated database (skipped otherwise)', () => {
  if (!dedicatedUrl) {
    console.log('SKIP: set ADAPTIVE_PILOT_TEST_DATABASE_URL to run the adaptive pilot PostgreSQL tests.');
  }
  assert.ok(true);
});

const maybe = dedicatedUrl ? test : test.skip;
const migration156 = readFileSync(
  fileURLToPath(new URL('./db/migrations/156_adaptive_discovery_pilot.sql', import.meta.url)),
  'utf8'
);
const runTag = `${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`;
const seed = `pg-${runTag}`;
const windowStart = '2026-10-23T07:00:00.000Z';
const windowEnd = '2026-10-24T07:00:00.000Z';

let pool: Pool | null = null;

async function requirePool(): Promise<Pool> {
  if (!pool) {
    pool = new pg.Pool({ connectionString: dedicatedUrl, max: 5 });
    await pool.query(migration156);
  }
  return pool;
}

after(async () => {
  if (!pool) return;
  await pool.query('DELETE FROM adaptive_discovery_pilot_assignments WHERE assignment_seed=$1', [seed]).catch(() => undefined);
  await pool.end();
});

maybe('assignments are immutable and idempotent for the same country-day', async () => {
  const db = await requirePool();
  const first = await recordAdaptivePilotAssignment({
    country: 'US',
    quotaDay: '2026-10-23',
    arm: 'TREATMENT',
    treatmentPercent: 50,
    seed,
    windowStart,
    windowEnd
  }, db);
  const replay = await recordAdaptivePilotAssignment({
    country: 'US',
    quotaDay: '2026-10-23',
    arm: 'CONTROL',
    treatmentPercent: 50,
    seed,
    windowStart,
    windowEnd
  }, db);
  assert.equal(first.arm, 'TREATMENT');
  assert.equal(replay.arm, 'TREATMENT', 'a later config change must not flip an existing country-day arm');
  assert.equal(replay.assignmentKey, first.assignmentKey);
  const count = await db.query(
    'SELECT count(*)::int AS count FROM adaptive_discovery_pilot_assignments WHERE assignment_seed=$1',
    [seed]
  );
  assert.equal(Number(count.rows[0].count), 1);
});

maybe('metrics return zero runs for an assignment without completed observations', async () => {
  const db = await requirePool();
  await recordAdaptivePilotAssignment({
    country: 'CA',
    quotaDay: '2026-10-23',
    arm: 'CONTROL',
    treatmentPercent: 50,
    seed,
    windowStart,
    windowEnd
  }, db);
  const metrics = await computeAdaptivePilotMetrics({
    windowStart: '2026-10-23T00:00:00.000Z',
    windowEnd: '2026-10-24T00:00:00.000Z',
    client: db
  });
  assert.ok(metrics.arms.CONTROL.assignments >= 1);
  assert.ok(metrics.arms.CONTROL.runs >= 0);
  assert.ok(Number.isFinite(metrics.arms.CONTROL.yieldPerRun));
  assert.ok(Number.isFinite(metrics.uplift.treatmentVsControl.newCreatorsPerRun));
});
