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
  query: async () => {
    calls.n++;
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
  assert.equal(calls.n, 1);
});

const scriptedPlannerClient = (calls: { sql: string[] }, settingValue: string | null) => ({
  query: async (sql: string) => {
    calls.sql.push(sql);
    if (sql.includes('app_settings')) {
      return { rows: settingValue == null ? [] : [{ setting_value: settingValue }] };
    }
    return { rows: [plannerTermsRow] };
  },
}) as any;

test('planner path: caller-supplied client reads the switch through that client (no app pool)', async () => {
  // Regression lock: the switch must not be read through getDb() when the
  // caller deliberately supplied its own client (staging proofs and read-only
  // tooling pass a client precisely to avoid the app pool's migration/seed
  // bootstrap). Without runner-aware reading this test would issue an atoms
  // query first, or leak a settings-read failure warning.
  const calls = { sql: [] as string[] };
  const terms = await getPlannerTerminology('Germany', scriptedPlannerClient(calls, 'true'));
  assert.deepEqual(terms, []);
  assert.equal(calls.sql.length, 1, `expected only the settings read, got: ${JSON.stringify(calls.sql)}`);
  assert.ok(
    calls.sql[0].includes('app_settings'),
    `expected the settings read through the supplied client, got: ${calls.sql[0]}`
  );
});

test('planner path: caller-supplied client with stop not set proceeds through the same client', async () => {
  const calls = { sql: [] as string[] };
  const terms = await getPlannerTerminology('Germany', scriptedPlannerClient(calls, null));
  assert.deepEqual(terms, [{ id: 1, term: 'DAX', score: 0.5, lifecycle: 'SEARCH_TRIAL' }]);
  assert.equal(calls.sql.length, 2, `expected settings read then atoms read, got: ${JSON.stringify(calls.sql)}`);
  assert.ok(calls.sql[0].includes('app_settings'), `first query should be the settings read, got: ${calls.sql[0]}`);
  assert.ok(
    calls.sql[1].includes('canonical_trading_terms'),
    `second query should be the atoms read, got: ${calls.sql[1]}`
  );
});
