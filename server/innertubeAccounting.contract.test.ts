import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const queueManager = readFileSync(new URL('./queueManager.ts', import.meta.url), 'utf8');
const dbCore = readFileSync(new URL('./dbCore.ts', import.meta.url), 'utf8');
const lineage = readFileSync(new URL('./executionLineageMetrics.ts', import.meta.url), 'utf8');
const monitor = readFileSync(new URL('../src/components/QueueMonitor.tsx', import.meta.url), 'utf8');

/**
 * InnerTube completion/failure accounting must aggregate under the InnerTube
 * provider identity, never the official YouTube path. Regression guard for
 * the dead-branch defect where `providerKey !== 'brave-search'` shadowed the
 * innertube branch and zeroed real InnerTube counts.
 */
test('run-outcome aggregation checks innertube before the official predicate', () => {
  const innertubeFirst = queueManager.indexOf("allocatedProvider.providerKey === 'youtube-innertube' && queryRunId");
  const officialPredicate = queueManager.indexOf("allocatedProvider.providerKey !== 'brave-search' && queryRunId");
  assert.ok(innertubeFirst !== -1, 'innertube outcome branch exists');
  assert.ok(officialPredicate !== -1, 'official outcome branch exists');
  assert.ok(innertubeFirst < officialPredicate, 'innertube branch must precede the official predicate or it is dead code');
});

test('outcome queries use static per-provider ledger predicates', () => {
  assert.match(queueManager, /provider='youtube-innertube' AND operation='search'/);
  assert.match(queueManager, /provider='youtube' AND operation='search'/);
  assert.doesNotMatch(queueManager, /\$\{.*\}.*AND operation='search'/);
});

test('failQueryRun recounts both ledgers with static predicates', () => {
  assert.match(dbCore, /provider='youtube-innertube' AND operation='search'/);
  assert.match(dbCore, /provider_key='youtube-innertube' THEN \(SELECT COUNT\(\*\)/);
  assert.match(dbCore, /provider_key='youtube-search' THEN \(SELECT COUNT\(\*\)/);
});

test('lineage metrics admit innertube attempts without renaming official buckets', () => {
  assert.match(lineage, /provider_key IN \('youtube-search','youtube-innertube'\)/);
  assert.match(lineage, /youtube_runs_with_provider_attempt/);
  assert.match(lineage, /youtube_innertube_runs_with_provider_attempt/);
});

test('queue monitor shows innertube separately and keeps official aggregates pure', () => {
  assert.match(monitor, /innertubeRows/);
  assert.match(monitor, /providerRows\.filter\(row => row\.provider\.toLowerCase\(\) === 'youtube' && isOfficialEnrichmentOperation/);
  assert.doesNotMatch(monitor, /officialRows.*youtube-innertube|youtube-innertube.*officialRows/);
});

test('quota-free runs never fall back to the official search path', () => {
  assert.match(queueManager, /quotaFreeInnertubeProvider \? \[\] : await searchYouTubeChannels/);
});

test('DATE retargeting re-checks caps and amends amounts without touching immutable lineage', () => {
  assert.match(dbCore, /DATE_ORDERING_RETARGETED_OFFICIAL/);
  // Frontier decision: amount fields only — provider identity columns are
  // trigger-immutable (migration 111 protect_provider_allocation_lineage).
  assert.match(dbCore, /UPDATE frontier_allocation_decisions SET quota_reserved=100, provider_reserved_amount=100 WHERE decision_id=\$1/);
  assert.doesNotMatch(dbCore, /UPDATE frontier_allocation_decisions SET quota_reserved=100, provider_key/);
  // Frontier caps apply only to frontier-authorized runs (legacy runs have no
  // frontier decision and consume no frontier allowance).
  assert.match(dbCore, /if \(candidate\.frontierDecisionId\) \{/);
  // Both daily caps re-checked with official units before amending anything.
  assert.match(dbCore, /FRONTIER_CANARY_DAILY_CAP_EXCEEDED \(date-ordering retarget needs official units\)/);
  assert.match(dbCore, /RETRIEVAL_CANARY_DAILY_CAP_EXCEEDED \(date-ordering retarget needs official units\)/);
});

test('ordinary scheduling rotates across ACTIVE providers for provider-less candidates', () => {
  assert.match(dbCore, /rotateActiveProviderRow\(rotationRes\.rows, `scheduled:\$\{candidate\.query\.id\}:\$\{candidate\.query\.country\}`\)/);
  // Rotation reads only real registry columns (provider_key, provider_family,
  // capabilities, quota_domain, mode) and derives the surface exactly like
  // the frontier allocator — a bad column would silently disable rotation.
  assert.match(dbCore, /SELECT provider_key,provider_family,capabilities,quota_domain,mode FROM discovery_provider_registry WHERE mode='ACTIVE'/);
  assert.doesNotMatch(dbCore, /FROM discovery_provider_registry WHERE mode='ACTIVE' AND capabilities \? 'SEARCH_YOUTUBE'[^`]*retrieval_surface/);
});
