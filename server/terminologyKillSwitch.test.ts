import assert from 'node:assert/strict';
import test from 'node:test';
import { TERMINOLOGY_KILL_SWITCH_KEY, isTerminologyKillSwitchActive } from './terminologyKillSwitch';
import { extractVocabularyFromCreator } from './queryIntelligence';
import { getPlannerTerminology } from './terminologyIntelligence';

/** Captures console.warn output while `fn` runs. */
async function withCapturedWarnings<T>(fn: () => Promise<T>): Promise<{ result: T; warnings: string[] }> {
  const warnings: string[] = [];
  const original = console.warn;
  console.warn = (...args: unknown[]) => {
    warnings.push(args.map(String).join(' '));
  };
  try {
    const result = await fn();
    return { result, warnings };
  } finally {
    console.warn = original;
  }
}

const reader = (value: string) => ({ readSetting: async () => value });

// ---------------------------------------------------------------------------
// Switch semantics: default-ON + only an explicit 'true' stops
// ---------------------------------------------------------------------------

test('kill switch: key is the agreed app_settings key', () => {
  assert.equal(TERMINOLOGY_KILL_SWITCH_KEY, 'terminology_kill_switch');
});

test('kill switch: missing/empty value means RUN (default-ON)', async () => {
  assert.equal(await isTerminologyKillSwitchActive(reader('')), false);
});

test('kill switch: explicit true (trimmed, case-insensitive) means STOP', async () => {
  assert.equal(await isTerminologyKillSwitchActive(reader('true')), true);
  assert.equal(await isTerminologyKillSwitchActive(reader('  TRUE  ')), true);
});

test('kill switch: non-true values mean RUN (false, 1, yes, garbage)', async () => {
  assert.equal(await isTerminologyKillSwitchActive(reader('false')), false);
  assert.equal(await isTerminologyKillSwitchActive(reader('1')), false);
  assert.equal(await isTerminologyKillSwitchActive(reader('yes')), false);
  assert.equal(await isTerminologyKillSwitchActive(reader('garbage')), false);
});

test('kill switch: settings read failure is failure-safe (loop continues, warn emitted)', async () => {
  const { result, warnings } = await withCapturedWarnings(() =>
    isTerminologyKillSwitchActive({
      readSetting: async () => {
        throw new Error('settings table unavailable');
      },
    })
  );
  assert.equal(result, false);
  assert.ok(
    warnings.some(w => w.includes('[Terminology Kill Switch]') && w.includes('default-ON')),
    `expected default-ON warning, got: ${JSON.stringify(warnings)}`
  );
});

test('kill switch: the default production reader is failure-safe when the settings store is unreachable', async () => {
  // Exercises the real default wiring (app_settings through the app pool):
  // with no database configured the read throws and must fall back to
  // default-ON with the warning — the injected-reader test above covers the
  // stub; this one locks the production wiring itself.
  const savedDatabaseUrl = process.env.DATABASE_URL;
  delete process.env.DATABASE_URL;
  try {
    const { result, warnings } = await withCapturedWarnings(() => isTerminologyKillSwitchActive());
    assert.equal(result, false);
    assert.ok(
      warnings.some(w => w.includes('[Terminology Kill Switch]') && w.includes('default-ON')),
      `expected default-ON warning from the default reader, got: ${JSON.stringify(warnings)}`
    );
  } finally {
    if (savedDatabaseUrl !== undefined) process.env.DATABASE_URL = savedDatabaseUrl;
  }
});

// ---------------------------------------------------------------------------
// Extraction path: extractVocabularyFromCreator is a hard no-op while active
// ---------------------------------------------------------------------------

const confirmedChannel = {
  channel_id: 'KILL_SWITCH_TEST',
  channel_name: 'Kill Switch Test Channel',
  country: 'Germany',
  trading_status: 'TRADING_CONFIRMED',
} as any;

test('extraction path: active switch returns [] without entering extraction work', async () => {
  // The injected seam lets this unit context prove the guard is the first
  // branch: with the switch active the function returns [] and warns before
  // any rule-observation or provider work runs.
  const { result, warnings } = await withCapturedWarnings(() =>
    extractVocabularyFromCreator(confirmedChannel, ['DAX Analyse'], 'Beschreibung', false, undefined, undefined, undefined, {
      isKillSwitchActive: async () => true,
    })
  );
  assert.deepEqual(result, []);
  assert.ok(
    warnings.some(w => w.includes('[Vocabulary Extraction]') && w.includes('terminology kill switch is active')),
    `expected kill-switch skip warning, got: ${JSON.stringify(warnings)}`
  );
});

test('extraction path: inactive switch proceeds into normal extraction work', async () => {
  // With the switch off the function must walk past the guard into its normal
  // dependencies. This unit context has no database, so the first database
  // touch (novelty-baseline load) rejects with the DATABASE_URL error —
  // proving the inactive path is not short-circuited the way the active path
  // is. A regression that also skipped inactive extraction would resolve []
  // instead of rejecting.
  const savedDatabaseUrl = process.env.DATABASE_URL;
  delete process.env.DATABASE_URL;
  try {
    await assert.rejects(
      () =>
        extractVocabularyFromCreator(confirmedChannel, [], '', false, undefined, undefined, undefined, {
          isKillSwitchActive: async () => false,
        }),
      /DATABASE_URL is required/
    );
  } finally {
    if (savedDatabaseUrl !== undefined) process.env.DATABASE_URL = savedDatabaseUrl;
  }
});

// ---------------------------------------------------------------------------
// Planner path: getPlannerTerminology returns no atoms while active
// ---------------------------------------------------------------------------

const plannerTermsRow = { id: 1, term: 'DAX', lifecycle_status: 'SEARCH_TRIAL', score: 0.5 };
const fakeClient = (calls: { n: number }) => ({
  query: async (sql: string) => {
    calls.n++;
    if (sql.includes('excluded_countries')) return { rows: [] };
    return { rows: [plannerTermsRow] };
  },
}) as any;

test('planner path: active switch returns no atoms without querying the database', async () => {
  const calls = { n: 0 };
  const terms = await getPlannerTerminology('Germany', fakeClient(calls), { isKillSwitchActive: async () => true });
  assert.deepEqual(terms, []);
  assert.equal(calls.n, 0, 'planner must not read terminology atoms while the kill switch is active');
});

test('planner path: inactive switch returns trial atoms unchanged', async () => {
  const calls = { n: 0 };
  const terms = await getPlannerTerminology('Germany', fakeClient(calls), { isKillSwitchActive: async () => false });
  assert.deepEqual(terms, [{ id: 1, term: 'DAX', score: 0.5, lifecycle: 'SEARCH_TRIAL' }]);
  // Two reads now: the exclusion-list guardrail read, then the atoms query.
  assert.equal(calls.n, 2);
});

const SAVEPOINT_SQL = /^(SAVEPOINT|RELEASE SAVEPOINT|ROLLBACK TO SAVEPOINT)/;

/**
 * Scripted queryable that mirrors PostgreSQL in autocommit mode (a pool, or a
 * client with no open transaction): SAVEPOINT is rejected with "can only be
 * used in transaction blocks", so the switch read falls back to a plain
 * statement — exactly what the staging proof's pool sees.
 */
const scriptedPlannerClient = (calls: { sql: string[] }, settingValue: string | null) => ({
  query: async (sql: string) => {
    calls.sql.push(sql);
    if (SAVEPOINT_SQL.test(sql)) {
      throw new Error('SAVEPOINT can only be used in transaction blocks');
    }
    if (sql.includes('app_settings')) {
      return { rows: settingValue == null ? [] : [{ setting_value: settingValue }] };
    }
    if (sql.includes('excluded_countries')) return { rows: [] };
    return { rows: [plannerTermsRow] };
  },
}) as any;

/** Data statements only — savepoint protocol calls are not gate semantics. */
const dataQueries = (calls: { sql: string[] }) => calls.sql.filter(sql => !SAVEPOINT_SQL.test(sql));

/**
 * Scripted queryable that mirrors a PoolClient inside an open transaction: a
 * failed statement aborts the transaction, and only a savepoint rollback
 * restores it (verified against PostgreSQL: until then every later statement
 * fails with "current transaction is aborted").
 */
const scriptedTransactionClient = (calls: { sql: string[] }, settingValue: string | null) => {
  let poisoned = false;
  return {
    query: async (sql: string) => {
      calls.sql.push(sql);
      if (sql.startsWith('SAVEPOINT') || sql.startsWith('RELEASE SAVEPOINT')) return { rows: [] };
      if (sql.startsWith('ROLLBACK TO SAVEPOINT')) {
        poisoned = false; // savepoint rollback restores a usable transaction
        return { rows: [] };
      }
      if (sql.includes('app_settings')) {
        if (settingValue == null) {
          poisoned = true; // e.g. a missing app_settings table aborts the transaction
          throw new Error('relation "app_settings" does not exist');
        }
        return { rows: [{ setting_value: settingValue }] };
      }
      if (poisoned) {
        throw new Error('current transaction is aborted, commands ignored until end of transaction block');
      }
      if (sql.includes('excluded_countries')) return { rows: [] };
      return { rows: [plannerTermsRow] };
    },
  } as any;
};

test('planner path: caller-supplied client reads the switch through that client (no app pool)', async () => {
  // Regression lock: the switch must not be read through getDb() when the
  // caller deliberately supplied its own client (staging proofs and read-only
  // tooling pass a client precisely to avoid the app pool's migration/seed
  // bootstrap). Without runner-aware reading this test would issue an atoms
  // query first, or leak a settings-read failure warning.
  const calls = { sql: [] as string[] };
  const terms = await getPlannerTerminology('Germany', scriptedPlannerClient(calls, 'true'));
  assert.deepEqual(terms, []);
  const data = dataQueries(calls);
  assert.equal(data.length, 1, `expected only the settings read, got: ${JSON.stringify(calls.sql)}`);
  assert.ok(
    data[0].includes('app_settings'),
    `expected the settings read through the supplied client, got: ${data[0]}`
  );
});

test('planner path: caller-supplied client with stop not set proceeds through the same client', async () => {
  const calls = { sql: [] as string[] };
  const terms = await getPlannerTerminology('Germany', scriptedPlannerClient(calls, null));
  assert.deepEqual(terms, [{ id: 1, term: 'DAX', score: 0.5, lifecycle: 'SEARCH_TRIAL' }]);
  const data = dataQueries(calls);
  assert.equal(data.length, 3, `expected settings, exclusions, then atoms read, got: ${JSON.stringify(calls.sql)}`);
  assert.ok(data[0].includes('app_settings'), `first query should be the settings read, got: ${data[0]}`);
  assert.ok(
    data[1].includes('excluded_countries'),
    `second query should be the exclusion-list guardrail read, got: ${data[1]}`
  );
  assert.ok(
    data[2].includes('canonical_trading_terms'),
    `third query should be the atoms read, got: ${data[2]}`
  );
});

test('planner path: failed settings read inside a caller transaction is confined by a savepoint', async () => {
  // Regression lock for the reviewed transaction-poisoning finding: without
  // the savepoint confinement the aborted transaction would make the atoms
  // query throw "current transaction is aborted" and the planner call would
  // reject instead of continuing failure-safe (default-ON).
  const calls = { sql: [] as string[] };
  const { result, warnings } = await withCapturedWarnings(() =>
    getPlannerTerminology('Germany', scriptedTransactionClient(calls, null))
  );
  assert.deepEqual(result, [{ id: 1, term: 'DAX', score: 0.5, lifecycle: 'SEARCH_TRIAL' }]);
  assert.ok(
    calls.sql.some(sql => sql.startsWith('ROLLBACK TO SAVEPOINT terminology_kill_switch')),
    `expected the failed read to roll back to the savepoint, got: ${JSON.stringify(calls.sql)}`
  );
  assert.ok(
    warnings.some(w => w.includes('[Terminology Kill Switch]') && w.includes('default-ON')),
    `expected default-ON warning, got: ${JSON.stringify(warnings)}`
  );
});

test('planner path: successful settings read inside a caller transaction releases the savepoint', async () => {
  const calls = { sql: [] as string[] };
  const { result, warnings } = await withCapturedWarnings(() =>
    getPlannerTerminology('Germany', scriptedTransactionClient(calls, 'true'))
  );
  assert.deepEqual(result, []);
  assert.ok(
    calls.sql.some(sql => sql.startsWith('RELEASE SAVEPOINT terminology_kill_switch')),
    `expected the savepoint to be released, got: ${JSON.stringify(calls.sql)}`
  );
  assert.equal(
    calls.sql.filter(sql => sql.includes('canonical_trading_terms')).length,
    0,
    'no atoms query may run while the stop is active'
  );
  assert.equal(warnings.length, 0, `expected no warnings, got: ${JSON.stringify(warnings)}`);
});
