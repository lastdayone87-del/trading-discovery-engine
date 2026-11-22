import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  evaluateInnertubeQuotaFallback,
  innertubeFallbackCursor,
  quotaFallbackMetadata,
  requiresContinuationHandoff,
} from './quotaFallback';

const compatible = {
  providerKey: 'youtube-search',
  searchOrdering: 'RELEVANCE',
  hasSearchWindow: false,
  retrievalTreatmentOrigin: 'CONTROL',
  allocationOrigin: 'LEGACY',
  hasTrial: false,
};

test('quota fallback accepts only an unwindowed RELEVANCE legacy official run', () => {
  assert.deepEqual(evaluateInnertubeQuotaFallback(compatible), { eligible: true, reasonCodes: [] });
});

test('quota fallback fails closed for semantics InnerTube cannot reproduce', () => {
  assert.deepEqual(
    evaluateInnertubeQuotaFallback({ ...compatible, searchOrdering: 'DATE' }).reasonCodes,
    ['ORDERING_NOT_RELEVANCE'],
  );
  assert.deepEqual(
    evaluateInnertubeQuotaFallback({ ...compatible, hasSearchWindow: true }).reasonCodes,
    ['SEARCH_WINDOW_UNSUPPORTED'],
  );
  assert.deepEqual(
    evaluateInnertubeQuotaFallback({ ...compatible, retrievalTreatmentOrigin: 'CANARY_TREATMENT' }).reasonCodes,
    ['RETRIEVAL_TREATMENT_ACTIVE'],
  );
  assert.deepEqual(
    evaluateInnertubeQuotaFallback({ ...compatible, allocationOrigin: 'FRONTIER_CANARY' }).reasonCodes,
    ['FRONTIER_LINEAGE_IMMUTABLE'],
  );
  assert.deepEqual(
    evaluateInnertubeQuotaFallback({ ...compatible, hasTrial: true }).reasonCodes,
    ['TRIAL_ACTIVE'],
  );
  assert.deepEqual(
    evaluateInnertubeQuotaFallback({ ...compatible, isContinuationChild: true }).reasonCodes,
    ['CONTINUATION_CHILD_CURSOR'],
  );
  assert.deepEqual(
    evaluateInnertubeQuotaFallback({ ...compatible, providerKey: 'youtube-innertube' }).reasonCodes,
    ['PROVIDER_NOT_OFFICIAL'],
  );
});

test('fallback cursor is the next provider page and requests a continuation handoff after page one', () => {
  assert.equal(innertubeFallbackCursor(0), '1');
  assert.equal(innertubeFallbackCursor(3), '4');
  assert.equal(requiresContinuationHandoff(0), false);
  assert.equal(requiresContinuationHandoff(3), true);
});

test('fallback metadata records the provider handoff without claiming official lineage', () => {
  const metadata = quotaFallbackMetadata({ fromProvider: 'youtube-search', reason: 'OFFICIAL_QUOTA_EXHAUSTED', pagesCompleted: 2 });
  assert.deepEqual(
    {
      fromProvider: (metadata.providerQuotaFallback as any).fromProvider,
      toProvider: (metadata.providerQuotaFallback as any).toProvider,
      reason: (metadata.providerQuotaFallback as any).reason,
      pagesCompleted: (metadata.providerQuotaFallback as any).pagesCompleted,
    },
    { fromProvider: 'youtube-search', toProvider: 'youtube-innertube', reason: 'OFFICIAL_QUOTA_EXHAUSTED', pagesCompleted: 2 },
  );
});

test('worker wires the fallback before the quota deferral and keeps the existing retry path', () => {
  const queue = readFileSync(new URL('./queueManager.ts', import.meta.url), 'utf8');
  assert.match(queue, /getQuotaFallbackRunState\(queryRunId\)/);
  assert.match(queue, /retargetQuotaBlockedRunToInnertube\(\{/);
  assert.match(queue, /isInnertubeQuotaFallbackAvailable\(\)/);
  assert.match(queue, /childProviderOverride: YOUTUBE_INNERTUBE_PROVIDER/);
  assert.match(queue, /Object\.keys\(args\.pageMetrics \|\| \{\}\)\.length \? args\.pageMetrics : finalMetrics/);
  assert.match(queue, /innertubeFallbackCursor\(fallbackState!\.pagesCompleted\)/);
  assert.match(queue, /await deferAutonomousRunForQuota\(queryRunId, 'AUTONOMOUS_QUERY_PAGE quota reservation denied'\)/);
  // The fallback must be attempted before the official deferral path.
  assert.ok(
    queue.indexOf('getQuotaFallbackRunState(queryRunId)') <
      queue.indexOf("await deferAutonomousRunForQuota(queryRunId, 'AUTONOMOUS_QUERY_PAGE quota reservation denied')"),
  );
});

test('first-page retarget is marker-gated and restricted to zero completed pages', () => {
  const dbCore = readFileSync(new URL('./dbCore.ts', import.meta.url), 'utf8');
  const migration = readFileSync(new URL('./db/migrations/201_innertube_quota_fallback.sql', import.meta.url), 'utf8');
  const start = dbCore.indexOf('export async function retargetQuotaBlockedRunToInnertube');
  const body = dbCore.slice(start, start + 5000);
  assert.match(body, /pages_completed \|\| 0\) !== 0/);
  assert.match(body, /quotaFallbackFrom: 'youtube-search'/);
  assert.match(body, /resume_mode='REWALK'/);
  assert.match(migration, /OLD\.pages_completed=0/);
  assert.match(migration, /OLD\.allocation_origin <> 'FRONTIER_CANARY'/);
  assert.match(migration, /OLD\.search_ordering='RELEVANCE'/);
  assert.match(migration, /OLD\.retrieval_treatment_origin='CONTROL'/);
  assert.match(migration, /OLD\.continued_from_run_id IS NULL/);
  assert.match(migration, /NEW\.provider_cursor->>'quotaFallbackFrom'='youtube-search'/);
  assert.match(migration, /RAISE EXCEPTION 'IMMUTABLE_QUERY_RUN_PROVIDER_LINEAGE'/);
  // Admission-pending deferral needs its own durable state, not a terminal
  // contamination value that the resume reconciler would finalize.
  assert.match(migration, /'QUOTA', 'TIME', 'ADMISSION'/);
  assert.match(dbCore, /metadata=COALESCE\(metadata,'\{\}'::jsonb\)\|\|\$8::jsonb/);
});
