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

function makeDb(rows: any[], options: { rowCount?: number } = {}) {
  const updates: Array<{ sql: string; params: unknown[] }> = [];
  return {
    updates,
    db: {
      query: async (sql: string, params: unknown[]) => {
        if (sql.includes('WITH mature AS')) return { rows };
        updates.push({ sql, params });
        return { rowCount: options.rowCount ?? 1, rows: [] };
      },
    },
  };
}

const readSetting = async (_key: string, fallback: string) => fallback;

test('mature exhausted query receives one reversible dormancy deadline with evidence', async () => {
  const { db, updates } = makeDb([{ ...row }]);
  const result = await runQuerySaturationSweep({
    db, readSetting, now: new Date('2026-11-16T00:00:00.000Z'), dormancyDays: 14,
  });
  assert.equal(result.evaluated, 1);
  assert.equal(result.dormant, 1);
  assert.equal(updates.length, 1);
  assert.match(updates[0].sql, /next_eligible_at/);
  assert.match(updates[0].sql, /next_eligible_at <= now\(\)/);
  assert.match(updates[0].sql, /NOT EXISTS/);
  assert.doesNotMatch(updates[0].sql, /REJECTED/);
  assert.equal(updates[0].params[0], 101);
  assert.equal(updates[0].params[1], '2026-11-30T00:00:00.000Z');
  const evidence = JSON.parse(String(updates[0].params[2]));
  assert.equal(evidence.state, 'DORMANT');
  assert.equal(evidence.dormancyDays, 14);
});

test('an existing future dormancy is preserved, not renewed', async () => {
  const { db, updates } = makeDb([{ ...row }], { rowCount: 0 });
  const result = await runQuerySaturationSweep({ db, readSetting, now: new Date('2026-11-16T00:00:00.000Z') });
  assert.equal(result.skippedExistingDormancy, 1);
  assert.equal(updates.length, 1);
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
    { ...row, query_id: 1, country: 'Ireland', mature_runs: 8, fresh_relevant: 1, known_channels: 95 },
    { ...row, query_id: 2, country: 'Ireland', mature_runs: 8, fresh_relevant: 1, known_channels: 95 },
    { ...row, query_id: 3, country: 'Canada', mature_runs: 8, fresh_relevant: 10, known_channels: 20 },
  ]);
  const result = await runQuerySaturationSweep({ db, readSetting, now: new Date('2026-11-16T00:00:00.000Z') });
  assert.equal(result.active, 3);
  assert.equal(result.dormant, 0);
});

test('zero-valued known-share setting is honored, not replaced by the default', async () => {
  const settings = new Map([
    ['query_saturation_known_share', '0'],
    ['query_saturation_min_mature_runs', '7'],
    ['query_saturation_max_pending_share', '0.2'],
    ['query_saturation_max_lcb_baseline_ratio', '0.5'],
  ]);
  const { db } = makeDb([{ ...row, known_channels: 99 }]);
  const result = await runQuerySaturationSweep({
    db,
    readSetting: async (key, fallback) => settings.get(key) ?? fallback,
    now: new Date('2026-11-16T00:00:00.000Z'),
  });
  assert.equal(result.policy.minimumKnownCreatorShare, 0);
});



test('bounded sweep rotates through later query groups instead of pinning the first page', async () => {
  const { db, updates } = makeDb([
    { ...row, query_id: 1 },
    { ...row, query_id: 2 },
    { ...row, query_id: 3 },
  ]);
  let persisted = '';
  const result = await runQuerySaturationSweep({
    db,
    limit: 1,
    now: new Date('2026-11-16T00:00:00.000Z'),
    readSetting: async (key, fallback) => key === 'query_saturation_cursor' ? '1' : fallback,
    setSetting: async (key, value) => { if (key === 'query_saturation_cursor') persisted = value; },
  });
  assert.equal(result.dormant, 1);
  assert.equal(updates[0].params[0], 2);
  assert.equal(persisted, '2');
});
