import test from 'node:test';
import assert from 'node:assert/strict';
import { runQuerySaturationSweep } from './querySaturationSweep';

const row = {
  query_id: 101,
  country: 'Canada',
  mature_runs: 10,
  distinct_results: 100,
  pending_classifications: 0,
  known_channels: 90,
  duplicate_results: 50,
  evaluated_raw_results: 150,
  official_quota_units: 1000,
  fresh_relevant: 0,
  fresh_quality: 0,
};

function makeDb(rows: any[]) {
  const updates: Array<{ sql: string; params: unknown[] }> = [];
  return {
    updates,
    db: {
      query: async (sql: string, params: unknown[]) => {
        if (sql.includes('WITH mature AS')) return { rows };
        updates.push({ sql, params });
        return { rowCount: 1, rows: [] };
      },
    },
  };
}

const readSetting = async (_key: string, fallback: string) => fallback;

test('mature exhausted query receives reversible next_eligible_at dormancy', async () => {
  const { db, updates } = makeDb([{ ...row }]);
  const result = await runQuerySaturationSweep({
    db, readSetting, now: new Date('2026-11-16T00:00:00.000Z'), dormancyDays: 14,
  });
  assert.equal(result.evaluated, 1);
  assert.equal(result.dormant, 1);
  assert.equal(updates.length, 1);
  assert.match(updates[0].sql, /next_eligible_at/);
  assert.match(updates[0].sql, /collection IN \('EXPERIMENTAL','PROVEN'\)/);
  assert.doesNotMatch(updates[0].sql, /REJECTED/);
  assert.equal(updates[0].params[0], 101);
});

test('productive mature query stays active and is not written', async () => {
  const { db, updates } = makeDb([{ ...row, fresh_relevant: 6, fresh_quality: 3, known_channels: 40, duplicate_results: 20 }]);
  const result = await runQuerySaturationSweep({ db, readSetting, now: new Date('2026-11-16T00:00:00.000Z') });
  assert.equal(result.active, 1);
  assert.equal(result.dormant, 0);
  assert.equal(updates.length, 0);
});

test('pending classification is insufficient evidence and is not written', async () => {
  const { db, updates } = makeDb([{ ...row, pending_classifications: 30 }]);
  const result = await runQuerySaturationSweep({ db, readSetting, now: new Date('2026-11-16T00:00:00.000Z') });
  assert.equal(result.insufficient, 1);
  assert.equal(updates.length, 0);
});

test('low-volume markets are evaluated against their own per-run baseline', async () => {
  const { db } = makeDb([
    { ...row, query_id: 1, country: 'Ireland', mature_runs: 8, fresh_relevant: 2, known_channels: 60 },
    { ...row, query_id: 2, country: 'Ireland', mature_runs: 8, fresh_relevant: 2, known_channels: 60 },
  ]);
  const result = await runQuerySaturationSweep({ db, readSetting, now: new Date('2026-11-16T00:00:00.000Z') });
  assert.equal(result.active, 2);
  assert.equal(result.dormant, 0);
});
