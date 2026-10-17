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

// ---------------------------------------------------------------------------
// Extraction path: extractVocabularyFromCreator is a hard no-op while active
// ---------------------------------------------------------------------------

const confirmedChannel = {
  channel_id: 'KILL_SWITCH_TEST',
  channel_name: 'Kill Switch Test Channel',
  country: 'Germany',
  trading_status: 'TRADING_CONFIRMED',
} as any;

test('extraction path: active switch short-circuits before any database/provider work', async () => {
  // No DATABASE_URL is configured in this unit test: if the guard were not the
  // first thing to run, the function would fail while loading rule-observation
  // infrastructure instead of returning cleanly.
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

test('extraction path: inactive switch proceeds past the guard (existing behavior preserved)', async () => {
  // With the switch off the function walks its normal guards. An unknown
  // country is the existing early exit, proving the switch-off path did not
  // get short-circuited by the kill-switch branch.
  const unknownCountryChannel = { ...confirmedChannel, country: 'Unknown' } as any;
  const result = await extractVocabularyFromCreator(unknownCountryChannel, [], '', false, undefined, undefined, undefined, {
    isKillSwitchActive: async () => false,
  });
  assert.deepEqual(result, []);
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
