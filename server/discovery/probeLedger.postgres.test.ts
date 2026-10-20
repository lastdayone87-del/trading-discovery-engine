import assert from 'node:assert/strict';
import test, { after, before, beforeEach } from 'node:test';
import pg from 'pg';
import type { Pool } from 'pg';
import {
  PROBE_SETTING_KEYS,
  SqlProbeLedgerStore,
  reserveProbe,
  type ProbeReserveResult,
} from './probeLedger';

/**
 * Live PostgreSQL proof that the budget locks serialize reservations across
 * different candidates. It runs only against the explicit dedicated database
 * supplied by CI (or a local scratch database), never DATABASE_URL.
 *
 * The database must have the normal migration lineage applied. The CI
 * workflow applies it with scripts/runMigrations.ts before this file runs.
 */
const dedicatedUrl =
  process.env.PROBE_LEDGER_TEST_DATABASE_URL ?? process.env.QUOTA_SHADOW_TEST_DATABASE_URL;
const maybe = dedicatedUrl ? test : test.skip;

const runTag = `${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`;
const prefix = `probe-pg-${runTag}`;
let pool: Pool | null = null;

before(async () => {
  if (!dedicatedUrl) return;
  pool = new pg.Pool({ connectionString: dedicatedUrl, max: 10 });
  const tables = await pool.query(
    `SELECT to_regclass('discovery_probe_ledger') AS ledger,
            to_regclass('discovery_provider_registry') AS providers`
  );
  assert.ok(tables.rows[0].ledger, 'apply migrations before running this suite');
  assert.ok(tables.rows[0].providers, 'apply migrations before running this suite');
});

beforeEach(async () => {
  // The absolute cap is table-wide. This suite owns the dedicated scratch
  // database and no other suite writes this table, so clear it for a
  // deterministic baseline (never run against a shared database).
  if (pool) await pool.query('DELETE FROM discovery_probe_ledger');
});

after(async () => {
  if (pool) {
    try {
      await pool.query(`DELETE FROM discovery_probe_ledger WHERE candidate_key LIKE $1`, [`${prefix}%`]);
    } finally {
      await pool.end();
    }
  }
});

function settings(overrides: Record<string, string> = {}) {
  const values: Record<string, string> = {
    [PROBE_SETTING_KEYS.maxPerCandidate]: '3',
    [PROBE_SETTING_KEYS.minIntervalHours]: '24',
    [PROBE_SETTING_KEYS.maxPerDay]: '20',
    [PROBE_SETTING_KEYS.maxPerCountryPerDay]: '10',
    [PROBE_SETTING_KEYS.maxTotal]: '30',
    [PROBE_SETTING_KEYS.allowedCountries]: 'US',
    ...overrides,
  };
  return async (key: string, fallback: string): Promise<string> => values[key] ?? fallback;
}

function reserve(candidateKey: string, now: Date, readSetting: ReturnType<typeof settings>) {
  assert.ok(pool);
  return reserveProbe(
    { candidateKey, term: 'orderflow', country: 'United States' },
    { store: new SqlProbeLedgerStore(pool), readSetting, now: () => now }
  );
}

function granted(results: ProbeReserveResult[]): number {
  return results.filter(result => result.granted).length;
}

maybe('different candidates cannot both pass the same UTC day cap', async () => {
  const now = new Date('2031-04-10T18:00:00.000Z');
  const readSetting = settings({ [PROBE_SETTING_KEYS.maxPerDay]: '1' });
  const results = await Promise.all([
    reserve(`${prefix}-day-a`, now, readSetting),
    reserve(`${prefix}-day-b`, now, readSetting),
  ]);
  assert.equal(granted(results), 1, 'exactly one reservation may fit the day cap');
  assert.ok(results.some(result => !result.granted && result.reason === 'GLOBAL_DAILY_CAP_REACHED'));
  assert.ok(pool);
  const count = await pool.query('SELECT count(*)::int AS count FROM discovery_probe_ledger');
  assert.equal(Number(count.rows[0].count), 1, 'the database itself must contain exactly one reservation');
});

maybe('different days still serialize on the absolute total cap', async () => {
  const readSetting = settings({ [PROBE_SETTING_KEYS.maxTotal]: '1' });
  const results = await Promise.all([
    reserve(`${prefix}-total-a`, new Date('2031-04-11T18:00:00.000Z'), readSetting),
    reserve(`${prefix}-total-b`, new Date('2031-04-12T18:00:00.000Z'), readSetting),
  ]);
  assert.equal(granted(results), 1, 'exactly one reservation may fit the absolute total cap');
  assert.ok(results.some(result => !result.granted && result.reason === 'TOTAL_BUDGET_EXHAUSTED'));
  assert.ok(pool);
  const count = await pool.query('SELECT count(*)::int AS count FROM discovery_probe_ledger');
  assert.equal(Number(count.rows[0].count), 1, 'the database itself must contain exactly one reservation');
});
