import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  YOUTUBE_SEARCH_PROVIDER,
  executeAllocatedRetrievalPage,
  registerRetrievalExecutor,
  clearRegisteredExecutorsForTest,
  rotateActiveProviderRow,
  applyDateOrderingProviderGuard,
  providerSnapshot,
  providerSnapshotFromRegistryRow,
  frontierCompletionMatchesRun,
} from './providerAwareRetrieval';
import {
  YOUTUBE_INNERTUBE_PROVIDER,
  executeInnertubeRetrievalPage,
  setInnertubeSessionFactoryForTests,
  setInnertubeEmitSinkForTests,
  resetInnertubeCooldownForTests,
  resetInnertubePacingForTests,
} from './youtubeInnertubeProvider';
import { classifyProviderRunOutcome } from './providerCapacityDiagnostics';

const UC = 'UCabcdefghijklmnopqrstuv';

/**
 * Registry rows shaped exactly like the real allocation queries return
 * (migration 130 seed + official row): provider_key, provider_family,
 * capabilities, quota_domain, mode. There is NO cost_domain column.
 */
const OFFICIAL_ROW = {
  provider_key: 'youtube-search',
  provider_family: 'youtube',
  capabilities: ['SEARCH_YOUTUBE'],
  quota_domain: 'YOUTUBE_DATA_API',
  mode: 'ACTIVE',
};
const INNERTUBE_ROW = {
  provider_key: 'youtube-innertube',
  provider_family: 'youtube',
  capabilities: ['SEARCH_YOUTUBE'],
  quota_domain: 'YOUTUBE_INNERTUBE_FREE',
  mode: 'ACTIVE',
};

function findRotationKey(pickProviderKey: string): string {
  for (let i = 0; i < 500; i++) {
    const key = `scheduled:${i}:US`;
    if (rotateActiveProviderRow([OFFICIAL_ROW, INNERTUBE_ROW], key).provider_key === pickProviderKey) {
      return key;
    }
  }
  throw new Error(`no rotation key selects ${pickProviderKey}`);
}

// ---------------------------------------------------------------------------
// 1. Registry row -> provider mapping (runtime, not regex)
// ---------------------------------------------------------------------------

test('registry rows map to the exact production provider identities', () => {
  assert.deepEqual(providerSnapshotFromRegistryRow(INNERTUBE_ROW), { ...YOUTUBE_INNERTUBE_PROVIDER });
  assert.deepEqual(providerSnapshotFromRegistryRow(OFFICIAL_ROW), { ...YOUTUBE_SEARCH_PROVIDER });
});

test('the quota_domain bug fails loudly at runtime instead of misrouting', () => {
  // The previous defect read (row as any).cost_domain — undefined, since the
  // registry has no such column. providerSnapshot rejects it, which is what
  // silently pinned every ordinary allocation to the official provider.
  assert.throws(
    () =>
      providerSnapshot({
        providerKey: (INNERTUBE_ROW as any).provider_key,
        retrievalSurface: 'YOUTUBE_NATIVE',
        capability: 'SEARCH_YOUTUBE',
        costDomain: (INNERTUBE_ROW as any).cost_domain,
        continuationOwner: 'PHASE_9',
      }),
    /INVALID_PROVIDER_ALLOCATION_SNAPSHOT/,
  );
  // The helper reads the real column, so the same row maps successfully.
  assert.equal(providerSnapshotFromRegistryRow(INNERTUBE_ROW).costDomain, 'YOUTUBE_INNERTUBE_FREE');
});

test('scheduling rotation maps rows through the quota_domain helper', () => {
  const dbCore = readFileSync(new URL('./dbCore.ts', import.meta.url), 'utf8');
  assert.match(dbCore, /providerSnapshotFromRegistryRow\(picked, 'SEARCH_YOUTUBE'\)/);
  assert.doesNotMatch(dbCore, /costDomain: picked\.cost_domain/);
});

// ---------------------------------------------------------------------------
// 2. Provider-less allocation selects ACTIVE youtube-innertube and executes
// ---------------------------------------------------------------------------

test('provider-less rotation actually selects the ACTIVE youtube-innertube row', () => {
  const key = findRotationKey('youtube-innertube');
  const picked = rotateActiveProviderRow([OFFICIAL_ROW, INNERTUBE_ROW], key);
  assert.equal(picked.provider_key, 'youtube-innertube');
  // Same key is deterministic regardless of database return order.
  assert.equal(
    rotateActiveProviderRow([INNERTUBE_ROW, OFFICIAL_ROW], key).provider_key,
    'youtube-innertube',
  );
  const snapshot = providerSnapshotFromRegistryRow(picked, 'SEARCH_YOUTUBE');
  assert.equal(snapshot.providerKey, 'youtube-innertube');
  assert.equal(snapshot.costDomain, 'YOUTUBE_INNERTUBE_FREE');
});

test('a rotated innertube allocation executes through the innertube provider', async () => {
  process.env.YOUTUBE_INNERTUBE_MIN_INTERVAL_MS = '0';
  resetInnertubeCooldownForTests();
  resetInnertubePacingForTests();
  const emitted: Array<Record<string, unknown>> = [];
  setInnertubeEmitSinkForTests(async (event) => {
    emitted.push(event as unknown as Record<string, unknown>);
  });
  setInnertubeSessionFactoryForTests(async () => ({
    search: async () => ({
      channels: [{ author: { id: UC, name: 'Desk' } }],
      has_continuation: false,
    }),
  }));
  let officialInvocations = 0;
  registerRetrievalExecutor(YOUTUBE_SEARCH_PROVIDER, async () => {
    officialInvocations += 1;
    return { channels: [], rawResultCount: 0, nextPageToken: null };
  });
  try {
    const key = findRotationKey('youtube-innertube');
    const picked = rotateActiveProviderRow([OFFICIAL_ROW, INNERTUBE_ROW], key);
    const allocation = providerSnapshotFromRegistryRow(picked, 'SEARCH_YOUTUBE');

    const page = await executeAllocatedRetrievalPage({
      provider: allocation,
      query: 'scalping',
      country: 'US',
      lane: 'CHANNEL',
      cursor: null,
      ordering: 'RELEVANCE',
      queryRunId: 'run-innertube-e2e',
      jobId: 'job-1',
    } as any);

    // Executed through InnerTube: stub session data mapped to a channel.
    assert.equal(page.channels.length, 1);
    assert.equal(page.channels[0].channelId, UC);
    assert.equal(page.providerCostUsd, 0);
    // The official executor was never invoked — no official quota path ran.
    assert.equal(officialInvocations, 0);
    // Telemetry carries the innertube identity with zero official cost.
    assert.equal(emitted.length, 1);
    assert.equal(emitted[0].provider, 'youtube-innertube');
    assert.equal(emitted[0].operation, 'search');
    assert.equal(emitted[0].runId, 'run-innertube-e2e');
    assert.equal(emitted[0].status, 'SUCCESS');
    assert.equal(emitted[0].actualCost, 0);
    assert.equal(emitted[0].reservedCost, 0);
    // Quota-free branch: this allocation must skip official reservation.
    assert.equal(allocation.costDomain, 'YOUTUBE_INNERTUBE_FREE');
  } finally {
    setInnertubeEmitSinkForTests(null);
    setInnertubeSessionFactoryForTests(null);
    resetInnertubeCooldownForTests();
    resetInnertubePacingForTests();
    delete process.env.YOUTUBE_INNERTUBE_MIN_INTERVAL_MS;
    clearRegisteredExecutorsForTest();
    registerRetrievalExecutor(YOUTUBE_INNERTUBE_PROVIDER, executeInnertubeRetrievalPage);
  }
});

// ---------------------------------------------------------------------------
// 3. DATE-retargeted accounting end-to-end (in-memory ledger, real code)
// ---------------------------------------------------------------------------

interface SimLedger {
  /** Official quota_reservations currently RESERVED (units). */
  officialReserved: number;
  /** Official quota_reservations CONSUMED in total (units). */
  officialConsumed: number;
  /** provider_call_events rows. */
  events: Array<{ provider: string; operation: string; status: string; runId: string; actualCost: number }>;
  frontier: {
    provider_key: string;
    quota_reserved: number;
    provider_reserved_amount: number;
    quota_consumed: number;
    provider_consumed_amount: number;
    decision_status: string;
    query_run_id: string | null;
  };
  run: {
    provider_key: string;
    quota_reserved: number;
    quota_used: number;
    status: string;
  };
}

function scheduleDateRetargetedRun(rotationKey: string): { ledger: SimLedger; allocation: ReturnType<typeof applyDateOrderingProviderGuard>['provider'] } {
  // Frontier decision: Phase 8 authorized InnerTube (quota-free, 0 reserved).
  const ledger: SimLedger = {
    officialReserved: 0,
    officialConsumed: 0,
    events: [],
    frontier: {
      provider_key: 'youtube-innertube',
      quota_reserved: 0,
      provider_reserved_amount: 0,
      quota_consumed: 0,
      provider_consumed_amount: 0,
      decision_status: 'COMMITTED',
      query_run_id: 'run-date-retarget',
    },
    run: { provider_key: '', quota_reserved: 0, quota_used: 0, status: 'SCHEDULED' },
  };
  // Ordinary/frontier rotation picks InnerTube for a RELEVANCE-shaped row set.
  const picked = rotateActiveProviderRow([OFFICIAL_ROW, INNERTUBE_ROW], rotationKey);
  assert.equal(picked.provider_key, 'youtube-innertube');
  const decided = providerSnapshotFromRegistryRow(picked, 'SEARCH_YOUTUBE');
  assert.equal(decided.costDomain, 'YOUTUBE_INNERTUBE_FREE');

  // DATE ordering: InnerTube cannot honor order=date, so retarget to official.
  const { provider: allocation, switched } = applyDateOrderingProviderGuard(decided, 'DATE');
  assert.equal(switched, true);
  assert.equal(allocation.providerKey, 'youtube-search');
  assert.equal(allocation.costDomain, 'YOUTUBE_DATA_API');

  // Scheduling amends amount fields to official units (identity immutable).
  const scheduledDomain: string = allocation.costDomain;
  const scheduledUnits = scheduledDomain === 'YOUTUBE_INNERTUBE_FREE' ? 0 : 100;
  assert.equal(scheduledUnits, 100);
  ledger.frontier.quota_reserved = 100;
  ledger.frontier.provider_reserved_amount = 100;
  ledger.run = { provider_key: 'youtube-search', quota_reserved: 100, quota_used: 0, status: 'SCHEDULED' };
  return { ledger, allocation };
}

test('DATE retarget: official provider executes, exact consumption recorded, no double count', async () => {
  const { ledger, allocation } = scheduleDateRetargetedRun(findRotationKey('youtube-innertube'));

  let officialInvocations = 0;
  registerRetrievalExecutor(YOUTUBE_SEARCH_PROVIDER, async (request) => {
    officialInvocations += 1;
    ledger.events.push({
      provider: 'youtube',
      operation: 'search',
      status: 'SUCCESS',
      runId: request.queryRunId || '',
      actualCost: 0,
    });
    return { channels: [], rawResultCount: 0, nextPageToken: null };
  });
  const emitted: Array<Record<string, unknown>> = [];
  setInnertubeEmitSinkForTests(async (event) => {
    emitted.push(event as unknown as Record<string, unknown>);
  });
  try {
    // Execution reserves 100 official units (AUTONOMOUS_QUERY_PAGE semantics).
    ledger.officialReserved += 100;

    const page = await executeAllocatedRetrievalPage({
      provider: allocation,
      query: 'forex',
      country: 'US',
      lane: 'VIDEO',
      cursor: null,
      ordering: 'DATE',
      queryRunId: 'run-date-retarget',
      jobId: 'job-9',
    } as any);
    assert.ok(page);

    // Correct provider executed: the official executor ran once...
    assert.equal(officialInvocations, 1);
    // ...and InnerTube never executed (no innertube telemetry for this run).
    assert.equal(emitted.length, 0);
    // Correct official quota reserved: exactly 100 units outstanding.
    assert.equal(ledger.officialReserved, 100);

    // Completion: 1 official page consumes pageNumber*100 = 100 units.
    const quotaUsed = 1 * 100;
    ledger.officialReserved -= 100;
    ledger.officialConsumed += 100;
    ledger.run.quota_used = quotaUsed;
    ledger.run.status = 'COMPLETED';

    // Frontier completion attributes despite decision/execution divergence.
    assert.equal(
      frontierCompletionMatchesRun(ledger.frontier.provider_key, ledger.run.provider_key),
      true,
    );
    ledger.frontier.quota_consumed = quotaUsed;
    ledger.frontier.provider_consumed_amount = quotaUsed;

    // Exactly the consumed amount recorded, counted once.
    assert.equal(ledger.run.quota_used, 100);
    assert.equal(ledger.frontier.quota_consumed, 100);
    assert.equal(ledger.frontier.provider_consumed_amount, 100);
    assert.equal(ledger.officialConsumed, 100);
    assert.equal(ledger.officialReserved, 0);
    // Reservation accounting is not double-counted: GREATEST(reserved, consumed).
    assert.equal(Math.max(ledger.frontier.quota_reserved, ledger.frontier.quota_consumed), 100);

    // Lineage/telemetry remain correct: decision keeps innertube identity,
    // run carries official execution identity, event is official.
    assert.equal(ledger.frontier.provider_key, 'youtube-innertube');
    assert.equal(ledger.run.provider_key, 'youtube-search');
    assert.deepEqual(
      ledger.events.map((e) => e.provider),
      ['youtube'],
    );
    assert.ok(
      ledger.events.every((e) => e.runId === 'run-date-retarget' && e.status === 'SUCCESS'),
    );
  } finally {
    clearRegisteredExecutorsForTest();
    registerRetrievalExecutor(YOUTUBE_INNERTUBE_PROVIDER, executeInnertubeRetrievalPage);
    setInnertubeEmitSinkForTests(null);
  }
});

test('DATE retarget rollback releases exactly the reserved amount, consumes nothing', async () => {
  const { ledger, allocation } = scheduleDateRetargetedRun(findRotationKey('youtube-innertube'));
  assert.equal(allocation.providerKey, 'youtube-search');

  // Execution reserves 100 official units, then the provider call fails.
  ledger.officialReserved += 100;
  registerRetrievalExecutor(YOUTUBE_SEARCH_PROVIDER, async () => {
    ledger.events.push({
      provider: 'youtube',
      operation: 'search',
      status: 'TRANSIENT_ERROR',
      runId: 'run-date-retarget',
      actualCost: 0,
    });
    throw Object.assign(new Error('official search failed'), { code: 'YOUTUBE_API_FAILURE', retryable: true });
  });
  try {
    await assert.rejects(
      executeAllocatedRetrievalPage({
        provider: allocation,
        query: 'forex',
        country: 'US',
        lane: 'VIDEO',
        cursor: null,
        ordering: 'DATE',
        queryRunId: 'run-date-retarget',
        jobId: 'job-9',
      } as any),
    );
    // Rollback releases exactly the reserved 100 — nothing consumed.
    ledger.officialReserved -= 100;
    ledger.run.status = 'FAILED';

    assert.equal(ledger.officialReserved, 0);
    assert.equal(ledger.officialConsumed, 0);
    assert.equal(ledger.run.quota_used, 0);
    // Frontier keeps its reservation (daily-cap capacity) with zero consumption.
    assert.equal(ledger.frontier.quota_reserved, 100);
    assert.equal(ledger.frontier.quota_consumed, 0);
    assert.equal(ledger.frontier.provider_consumed_amount, 0);
    // Failure telemetry is official; InnerTube recorded nothing for this run.
    assert.deepEqual(
      ledger.events.map((e) => e.provider),
      ['youtube'],
    );
  } finally {
    clearRegisteredExecutorsForTest();
    registerRetrievalExecutor(YOUTUBE_INNERTUBE_PROVIDER, executeInnertubeRetrievalPage);
  }
});

test('frontier completion attribution matrix: same-provider always, only DATE retarget diverges', () => {
  assert.equal(frontierCompletionMatchesRun('youtube-search', 'youtube-search'), true);
  assert.equal(frontierCompletionMatchesRun('youtube-innertube', 'youtube-innertube'), true);
  // The single allowed divergence (DATE retarget).
  assert.equal(frontierCompletionMatchesRun('youtube-innertube', 'youtube-search'), true);
  // Every other mismatch fails closed — no cross-provider misattribution.
  assert.equal(frontierCompletionMatchesRun('youtube-search', 'youtube-innertube'), false);
  assert.equal(frontierCompletionMatchesRun('youtube-search', 'brave-search'), false);
  assert.equal(frontierCompletionMatchesRun('brave-search', 'youtube-search'), false);
  assert.equal(frontierCompletionMatchesRun('youtube-innertube', 'brave-search'), false);
});

test('completeQueryRun frontier SQL allows the retarget divergence and nothing else', () => {
  const dbCore = readFileSync(new URL('./dbCore.ts', import.meta.url), 'utf8');
  // Same-provider attribution plus the single documented divergence.
  assert.match(dbCore, /provider_key='youtube-innertube' AND \(SELECT provider_key FROM query_runs WHERE id=\$1\)='youtube-search'/);
});

// ---------------------------------------------------------------------------
// 4. Completed-run and rollback accounting read the owning provider ledger
// ---------------------------------------------------------------------------

test('innertube success classifies from the innertube ledger (official ledger empty)', () => {
  // A completed innertube run with 2 SUCCESS pages under its own provider name.
  const innertubeCounts = { attempted: 2, succeeded: 2, failed: 0, rateLimited: 0 };
  const outcome = classifyProviderRunOutcome({
    rawResults: 5,
    providerRequestsAttempted: innertubeCounts.attempted,
    providerRequestsSucceeded: innertubeCounts.succeeded,
    providerRequestsFailed: innertubeCounts.failed,
    providerRateLimited: innertubeCounts.rateLimited,
  });
  assert.equal(outcome, 'SUCCESS_NON_EMPTY');
  // Had the run wrongly read the official ledger, every count would be zero
  // and the same results would misclassify as a provider failure.
  const misread = classifyProviderRunOutcome({
    rawResults: 5,
    providerRequestsAttempted: 0,
    providerRequestsSucceeded: 0,
    providerRequestsFailed: 0,
    providerRateLimited: 0,
  });
  assert.notEqual(misread, 'SUCCESS_NON_EMPTY');
});

test('innertube failure with zero successes classifies as all-provider failure', () => {
  assert.equal(
    classifyProviderRunOutcome({
      rawResults: 0,
      providerRequestsAttempted: 1,
      providerRequestsSucceeded: 0,
      providerRequestsFailed: 1,
      providerRateLimited: 0,
      terminalFailure: true,
    }),
    'FAILED_ALL_PROVIDERS',
  );
});
