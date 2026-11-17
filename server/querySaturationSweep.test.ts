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
  known_classified: 90,
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
        if (sql.includes('SUM(fresh_relevant)')) {
          const minimum = Number(params[0]);
          const maximumPending = Number(params[1]);
          const baseline = new Map<string, { fresh: number; runs: number }>();
          for (const candidate of rows) {
            if (candidate.mature_runs < minimum) continue;
            if (candidate.pending_classifications > candidate.distinct_results * maximumPending) continue;
            const current = baseline.get(candidate.country) || { fresh: 0, runs: 0 };
            current.fresh += candidate.fresh_relevant;
            current.runs += candidate.mature_runs;
            baseline.set(candidate.country, current);
          }
          return { rows: [...baseline].map(([country, value]) => ({ country, ...value })) };
        }
        if (sql.includes('SELECT * FROM grouped')) {
          const afterId = params[0] as number | null;
          const afterCountry = params[1] as string | null;
          const limited = rows
            .slice()
            .sort((a, b) => a.query_id - b.query_id || a.country.localeCompare(b.country))
            .filter(candidate => afterId === null
              || candidate.query_id > afterId
              || (candidate.query_id === afterId && candidate.country > String(afterCountry)))
            .slice(0, Number(params[2]));
          return { rows: limited };
        }
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
    readSetting: async (key, fallback) => key === 'query_saturation_cursor' ? '1|Canada' : fallback,
    setSetting: async (key, value) => { if (key === 'query_saturation_cursor') persisted = value; },
  });
  assert.equal(result.dormant, 1);
  assert.equal(updates[0].params[0], 2);
  assert.equal(persisted, '2|Canada');
});


test('baselines and the bounded decision batch use separate SQL queries', async () => {
  const seen: Array<{ sql: string; params: unknown[] }> = [];
  const db = {
    query: async (sql: string, params: unknown[]) => {
      seen.push({ sql, params });
      if (sql.includes('SUM(fresh_relevant)')) return { rows: [{ country: 'Canada', fresh: 0, runs: 10 }] };
      if (sql.includes('SELECT * FROM grouped')) return { rows: [{ ...row }] };
      return { rowCount: 1, rows: [] };
    },
  };
  await runQuerySaturationSweep({ db, readSetting, limit: 25, now: new Date('2026-11-16T00:00:00.000Z') });
  const baseline = seen.find(entry => entry.sql.includes('SUM(fresh_relevant)'));
  const batch = seen.find(entry => entry.sql.includes('SELECT * FROM grouped'));
  assert.ok(baseline);
  assert.ok(batch);
  assert.match(batch!.sql, /LIMIT \$3/);
  assert.equal(batch!.params[2], 26);
  assert.doesNotMatch(baseline!.sql, /LIMIT \$3/);
});


test('sweep passes classified-only known share to the evaluator', async () => {
  const { db, updates } = makeDb([{
    ...row,
    pending_classifications: 10,
    known_channels: 90,
    known_classified: 60,
  }]);
  const result = await runQuerySaturationSweep({
    db, readSetting, now: new Date('2026-11-16T00:00:00.000Z'),
  });
  assert.equal(result.active, 1);
  assert.equal(result.dormant, 0);
  assert.equal(updates.length, 0);
});
