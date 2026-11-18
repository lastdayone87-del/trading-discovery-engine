import test from 'node:test';
import assert from 'node:assert/strict';
import {
  claimCommunityWorkSlice,
  materializeCommunityWorkForChannel,
  completeCommunityWorkSlice,
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
    failure_class: input.failureClass ?? 'NETWORK_FAILURE',
    observed_at: input.observedAt,
    provenance: {
      surface: input.surface || 'CREATOR_WEBSITES',
      required: input.required ?? true,
      ...(input.telemetry ? { crawlerTelemetry: input.telemetry } : {}),
      ...(input.workLeaseToken ? { workLeaseToken: input.workLeaseToken } : {}),
    },
  };
}

function materializeDb(fixtures: ReturnType<typeof observation>[]) {
  const inserts: any[] = [];
  const queries: Array<{ sql: string; params?: unknown[] }> = [];
  return {
    inserts,
    queries,
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
        inserts.push(JSON.parse(String(params?.[0] || '[]')));
        return { rows: [], rowCount: 2 };
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
      observedAt: '2026-11-01T00:00:01.000Z',
      telemetry: { mode: 'STATIC', pagesInspected: 2 },
    }),
    observation({
      id: 'r1',
      url: 'https://scan.example/community',
      observedAt: '2026-11-01T00:00:42.000Z',
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
