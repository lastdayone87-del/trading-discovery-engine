import test from 'node:test';
import assert from 'node:assert/strict';
import {
  claimCommunityWorkSlice,
  materializeCommunityWorkForChannel,
  completeCommunityWorkSlice,
  retireTerminalChannelCommunityWork,
  type CommunityWorkRow,
} from './communityAcquisitionWorkStore';
import { communityAcquisitionWorkKey } from './communityAcquisitionWorkLedger';

const LEASE_A = '11111111-1111-4111-8111-111111111111';
const LEASE_B = '22222222-2222-4222-8222-222222222222';

function observation(input: {
  id: string;
  channel?: string;
  url: string;
  outcome?: string;
  retryable?: boolean;
  failureClass?: string | null;
  observedAt: string;
  required?: boolean;
  surface?: string;
  workLeaseToken?: string;
  telemetry?: Record<string, unknown>;
}) {
  return {
    id: input.id,
    channel_id: input.channel || 'UC-ledger',
    requested_url: input.url,
    outcome: input.outcome || 'ACQUISITION_FAILED',
    retryable: input.retryable ?? true,
    failure_class: input.failureClass === undefined ? 'NETWORK_FAILURE' : input.failureClass,
    observed_at: input.observedAt,
    provenance: {
      surface: input.surface || 'CREATOR_WEBSITES',
      required: input.required ?? true,
      ...(input.telemetry ? { crawlerTelemetry: input.telemetry } : {}),
      ...(input.workLeaseToken ? { workLeaseToken: input.workLeaseToken } : {}),
    },
  };
}

function materializeDb(
  fixtures: ReturnType<typeof observation>[],
  seed: Array<Record<string, any>> = [],
) {
  const inserts: any[] = [];
  const queries: Array<{ sql: string; params?: unknown[] }> = [];
  const ledger = new Map<string, Record<string, any>>(seed.map(row => [String(row.work_key), { ...row }]));
  return {
    inserts,
    queries,
    ledger,
    async query(sql: string, params?: unknown[]) {
      queries.push({ sql, params });
      if (sql.includes('FROM external_acquisition_observations')) {
        // Behave like the production query: bind the channel and surface set,
        // not just "return whatever the fixture contains".
        assert.equal(params?.[0], 'UC-ledger');
        assert.equal(params?.[1], '90');
        assert.ok(Array.isArray(params?.[2]) && params![2].includes('CREATOR_WEBSITES'));
        return { rows: fixtures.filter(row => row.channel_id === params?.[0]) };
      }
      if (sql.includes('INSERT INTO community_acquisition_url_state')) {
        const rows = JSON.parse(String(params?.[0] || '[]'));
        inserts.push(rows);
        // Model the production ON CONFLICT contract just enough to exercise
        // recovery: RESOLVED and budget-neutral UNREACHED_SLICE rows can be
        // replaced by newer PENDING/PARKED evidence; MAX_ATTEMPTS cannot.
        for (const row of rows) {
          const existing = ledger.get(String(row.work_key));
          if (!existing) {
            ledger.set(String(row.work_key), row);
            continue;
          }
          const recoverable = existing.state === 'RESOLVED'
            || (existing.state === 'EXHAUSTED' && existing.terminal_reason === 'UNREACHED_SLICE');
          const newer = String(existing.terminal_evidence?.latestObservedAt || '')
            < String(row.terminal_evidence?.latestObservedAt || '');
          if (recoverable && ['PENDING','PARKED_INFRA'].includes(String(row.state)) && newer) {
            ledger.set(String(row.work_key), row);
          }
        }
        return { rows: [], rowCount: rows.length };
      }
      throw new Error(`unexpected SQL: ${sql.slice(0, 80)}`);
    },
  };
}

test('materialize preserves required work and optional multi-invite recall rows', async () => {
  const db = materializeDb([
    observation({
      id: '1',
      url: 'https://required.example/join',
      observedAt: '2026-11-01T00:00:00.000Z',
      telemetry: { mode: 'RENDERED', pagesInspected: 1, requestsFinished: 1 },
    }),
    observation({
      id: '2',
      url: 'https://optional.example/community',
      required: false,
      failureClass: 'TIMEOUT',
      observedAt: '2026-11-01T00:01:00.000Z',
      telemetry: { mode: 'STATIC', pagesInspected: 0, requestsStarted: 1 },
    }),
    observation({
      id: '3',
      channel: 'UC-other',
      url: 'https://other-channel.example/join',
      observedAt: '2026-11-01T00:02:00.000Z',
    }),
  ]);

  const result = await materializeCommunityWorkForChannel('UC-ledger', { db });
  assert.equal(result.projected, 2, 'another channel must never be materialized');
  assert.equal(db.inserts.length, 1);
  const rows = db.inserts[0];
  assert.equal(rows.length, 2);
  const required = rows.find((row: any) => row.url.includes('required.example'));
  const recall = rows.find((row: any) => row.url.includes('optional.example'));
  assert.equal(required.required, true);
  assert.equal(required.recall, false);
  assert.equal(required.priority, 100);
  assert.equal(required.state, 'PENDING');
  assert.ok(required.attempts >= 1, 'processed evidence must seed a valid attempt count');
  assert.equal(recall.required, false);
  assert.equal(recall.recall, true);
  assert.equal(recall.priority, 10);
  assert.equal(recall.state, 'PENDING');
});

test('MAX_ATTEMPTS exhaustion keeps its saved budget after old observations age out', async () => {
  const url = 'https://budget.example/community';
  const workKey = communityAcquisitionWorkKey('UC-ledger', url, 'CREATOR_WEBSITES');
  const db = materializeDb(
    [observation({ id: 'fresh', url, observedAt: '2026-11-02T00:00:00.000Z' })],
    [{
      work_key: workKey,
      state: 'EXHAUSTED',
      terminal_reason: 'MAX_ATTEMPTS',
      terminal_evidence: { latestObservedAt: '2026-11-01T00:00:00.000Z' },
    }],
  );
  await materializeCommunityWorkForChannel('UC-ledger', { db });
  assert.equal(db.ledger.get(workKey)?.state, 'EXHAUSTED',
    'a capped URL must not regain attempts merely because old rows left the window');
  const insertSql = db.queries.find(query => query.sql.includes('INSERT INTO community_acquisition_url_state'))?.sql || '';
  assert.match(insertSql, /terminal_reason='UNREACHED_SLICE'/);
});

test('budget-neutral UNREACHED_SLICE exhaustion recovers on newer evidence', async () => {
  const url = 'https://unreached.example/community';
  const workKey = communityAcquisitionWorkKey('UC-ledger', url, 'CREATOR_WEBSITES');
  const db = materializeDb(
    [observation({ id: 'fresh', url, observedAt: '2026-11-02T00:00:00.000Z' })],
    [{
      work_key: workKey,
      state: 'EXHAUSTED',
      terminal_reason: 'UNREACHED_SLICE',
      terminal_evidence: { latestObservedAt: '2026-11-01T00:00:00.000Z', noObservationCount: 5 },
    }],
  );
  await materializeCommunityWorkForChannel('UC-ledger', { db });
  const recovered = db.ledger.get(workKey);
  assert.equal(recovered?.state, 'PENDING');
  assert.equal(recovered?.retryable, true);
});

test('a found direct invite stays claimable until its validation pass completes', async () => {
  const db = materializeDb([
    observation({
      id: 'invite',
      url: 'https://discord.gg/ledger-direct',
      outcome: 'FOUND',
      retryable: false,
      failureClass: null,
      observedAt: '2026-11-01T00:00:00.000Z',
      surface: 'CHANNEL_EXTERNAL_LINKS',
    }),
  ]);
  const result = await materializeCommunityWorkForChannel('UC-ledger', { db });
  assert.equal(result.projected, 1);
  const row = db.inserts[0][0];
  assert.equal(row.state, 'PENDING', 'a found invite without validation evidence must remain claimable');
  assert.equal(row.retryable, true);
});

test('one inspection does not consume two attempts when static and rendered rows differ in time', async () => {
  const sameInspection = materializeDb([
    observation({
      id: 's1',
      url: 'https://scan.example/community',
      observedAt: '2026-11-01T00:00:42.000Z',
      telemetry: { mode: 'STATIC', pagesInspected: 2 },
    }),
    observation({
      id: 'r1',
      url: 'https://scan.example/community',
      observedAt: '2026-11-01T00:00:01.000Z',
      telemetry: { mode: 'RENDERED', pagesInspected: 4 },
    }),
    observation({
      id: 'retry',
      url: 'https://scan.example/community',
      observedAt: '2026-11-01T00:06:00.000Z',
      telemetry: { mode: 'RENDERED', pagesInspected: 4 },
    }),
  ]);
  const sameInspectionResult = await materializeCommunityWorkForChannel('UC-ledger', { db: sameInspection });
  assert.equal(sameInspectionResult.projected, 1);
  const row = sameInspection.inserts[0][0];
  assert.equal(row.attempts, 2, 'the later retry is a second claim; the first two rows are one');
  assert.notEqual(row.state, 'EXHAUSTED');

  const leased = materializeDb([
    observation({
      id: 'a1',
      url: 'https://leased.example/community',
      observedAt: '2026-11-01T00:00:01.000Z',
      workLeaseToken: LEASE_A,
    }),
    observation({
      id: 'a2',
      url: 'https://leased.example/community',
      observedAt: '2026-11-01T00:00:02.000Z',
      workLeaseToken: LEASE_A,
    }),
    observation({
      id: 'b1',
      url: 'https://leased.example/community',
      observedAt: '2026-11-01T00:00:03.000Z',
      workLeaseToken: LEASE_B,
    }),
  ]);
  const leasedResult = await materializeCommunityWorkForChannel('UC-ledger', { db: leased });
  assert.equal(leasedResult.projected, 1);
  assert.equal(leased.inserts[0][0].attempts, 2, 'two distinct claims are two attempts');
});

test('terminal-channel retirement resolves every active ledger state', async () => {
  const updates: Array<{ sql: string; params?: unknown[] }> = [];
  const db = {
    async query(sql: string, params?: unknown[]) {
      updates.push({ sql, params });
      return { rows: [], rowCount: 4 };
    },
  };
  const retired = await retireTerminalChannelCommunityWork('UC-ledger', db);
  assert.equal(retired, 4);
  const sql = updates[0].sql;
  assert.match(sql, /SET state='RESOLVED'/);
  assert.match(sql, /terminal_reason='CHANNEL_TERMINAL'/);
  assert.match(sql, /retryable=FALSE/);
  assert.match(sql, /lease_token=NULL/);
  assert.match(sql, /next_eligible_at=now\(\)/);
  assert.match(sql, /state IN \('PENDING','RUNNING','PARKED_INFRA','PARKED_EXTERNAL'\)/);
  assert.match(sql, /EXISTS \(\s*SELECT 1 FROM channels c/);
  assert.match(sql, /c\.country_status='REJECTED'/);
  assert.match(sql, /c\.trading_status IN \('NON_TRADING','HUMAN_REJECTED'\)/);
  assert.match(sql, /c\.scan_status IN \('SKIPPED_EXCLUDED','SKIPPED_NON_TRADING'\)/);
  assert.equal(updates[0].params?.[0], 'UC-ledger');
});

test('a slice never claims two surfaces for the same normalized URL', async () => {
  const base = {
    channel_id: 'UC-ledger',
    normalized_url: 'https://same.example/community',
    required: true,
    recall: false,
    priority: 100,
    never_executed: false,
    browser_executed: true,
    attempts: 1,
    max_attempts: 5,
    first_observed_at: '2026-11-01T00:00:00.000Z',
    last_attempt_at: '2026-11-01T00:00:00.000Z',
    next_eligible_at: '2026-11-01T00:00:00.000Z',
    last_failure_class: null,
    last_outcome: 'ACQUISITION_FAILED',
    terminal_reason: null,
    terminal_evidence: {},
  };
  const updates: Array<{ sql: string; params?: unknown[] }> = [];
  const db = {
    async query(sql: string, params?: unknown[]) {
      if (sql.includes('WITH due AS')) {
        return {
          rows: [
            { ...base, work_key: 'a', url: 'https://same.example/community', surface: 'CREATOR_WEBSITES', state: 'RUNNING', lease_token: LEASE_A },
            { ...base, work_key: 'b', url: 'https://same.example/community', surface: 'SOCIAL_PROFILES', state: 'RUNNING', lease_token: LEASE_B },
            { ...base, work_key: 'c', url: 'https://other.example/community', normalized_url: 'https://other.example/community', surface: 'CREATOR_WEBSITES', state: 'RUNNING', lease_token: LEASE_A },
          ],
        };
      }
      if (sql.includes('UPDATE community_acquisition_url_state')) {
        updates.push({ sql, params });
        return { rows: [], rowCount: 1 };
      }
      throw new Error(`unexpected SQL: ${sql.slice(0, 80)}`);
    },
  };
  const slice = await claimCommunityWorkSlice('UC-ledger', db, 8);
  assert.deepEqual(slice.map((row) => row.workKey), ['a', 'c']);
  assert.equal(updates.length, 1, 'the duplicate surface claim is released, not processed');
  assert.deepEqual(updates[0].params?.slice(0, 3), ['b', updates[0].params?.[1], LEASE_B]);
});

test('completeCommunityWorkSlice reports an exhausted row as exhausted and clears retryable', async () => {
  const url = 'https://exhaust.example/community';
  const workKey = communityAcquisitionWorkKey('UC-ledger', url, 'CREATOR_WEBSITES');
  const claimed: CommunityWorkRow = {
    workKey,
    channelId: 'UC-ledger',
    url,
    normalizedUrl: url,
    surface: 'CREATOR_WEBSITES',
    state: 'RUNNING',
    leaseToken: LEASE_A,
    required: true,
    recall: false,
    priority: 100,
    neverExecuted: false,
    neverBrowserExecuted: false,
    attempts: 4,
    maxAttempts: 5,
    firstObservedAt: '2026-11-01T00:00:00.000Z',
    lastAttemptAt: '2026-11-01T00:00:00.000Z',
    nextEligibleAt: '2026-11-01T00:00:00.000Z',
    lastFailureClass: 'NETWORK_FAILURE',
    lastOutcome: 'ACQUISITION_FAILED',
    terminalReason: null,
    terminalEvidence: {},
  };
  const updates: Array<{ sql: string; params?: unknown[] }> = [];
  const db = {
    async query(sql: string, params?: unknown[]) {
      if (sql.includes('FROM external_acquisition_observations')) {
        return {
          rows: [
            observation({
              id: 'latest',
              url,
              observedAt: '2026-11-01T00:01:00.000Z',
              workLeaseToken: LEASE_A,
            }),
          ],
        };
      }
      if (sql.includes('UPDATE community_acquisition_url_state')) {
        updates.push({ sql, params });
        return { rows: [{ state: 'EXHAUSTED' }], rowCount: 1 };
      }
      throw new Error(`unexpected SQL: ${sql.slice(0, 80)}`);
    },
  };

  const result = await completeCommunityWorkSlice('UC-ledger', [claimed], { db });
  assert.equal(result.updated, 1);
  assert.equal(result.exhausted, 1);
  assert.equal(result.pending, 0);
  assert.equal(updates.length, 1);
  assert.equal(updates[0].params?.[1], 'EXHAUSTED');
  assert.equal(updates[0].params?.[11], false, 'EXHAUSTED must not stay retryable');
});
