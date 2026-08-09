import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { resolvePlaylistLineage, type PlaylistLineageCandidate } from './playlistLineageReconciler';

const candidate: PlaylistLineageCandidate = { frontierActionId: 'frontier-1', semanticActionKey: 'semantic-1', jobId: 'job-1', jobIdempotencyKey: 'playlist:semantic-1', adapterRunId: 'run-1' };

test('reconciles only one complete and internally consistent durable path', () => {
  const first = resolvePlaylistLineage([candidate]);
  assert.deepEqual(first, resolvePlaylistLineage([candidate]));
  assert.equal(first.result, 'PASS');
  assert.deepEqual(first.candidate, candidate);
});

test('missing, ambiguous, or inconsistent evidence always abstains', () => {
  assert.deepEqual(resolvePlaylistLineage([]).reasonCodes, ['PLAYLIST_LINEAGE_EVIDENCE_INCOMPLETE']);
  assert.deepEqual(resolvePlaylistLineage([candidate, { ...candidate, frontierActionId: 'frontier-2', jobId: 'job-2' }]).reasonCodes, ['PLAYLIST_LINEAGE_EVIDENCE_AMBIGUOUS']);
  assert.deepEqual(resolvePlaylistLineage([{ ...candidate, jobIdempotencyKey: 'wrong' }]).reasonCodes, ['PLAYLIST_LINEAGE_EVIDENCE_INCONSISTENT']);
  assert.equal(resolvePlaylistLineage([]).result, 'ABSTAIN');
});

test('migration is disabled, immutable, append-only, and non-serving', () => {
  const sql = readFileSync(new URL('../db/migrations/078_creator_playlist_lineage_reconciliation.sql', import.meta.url), 'utf8');
  assert.match(sql, /enabled BOOLEAN NOT NULL DEFAULT false/);
  assert.match(sql, /result IN\('PASS','ABSTAIN'\)/);
  assert.match(sql, /serving_authority=false/);
  assert.match(sql, /reconciliation_events_immutable/);
  assert.doesNotMatch(sql, /INSERT INTO jobs|UPDATE (creator_search_canary_assignments|jobs|frontier_actions|acquisition_adapter_runs)|DELETE FROM|DROP TABLE|TRUNCATE/i);
});

test('reconciler cannot enqueue, execute, retry, or mutate operational state', () => {
  const source = readFileSync(new URL('./playlistLineageReconciler.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /enqueuePlaylistCanary|enqueueJob|fetchYouTube|completeJob|processPlaylist|INSERT INTO jobs|UPDATE (creator_search_canary_assignments|jobs|frontier_actions|acquisition_adapter_runs)/i);
  assert.match(source, /INSERT INTO creator_playlist_canary_execution_links/);
  assert.match(source, /INSERT INTO creator_playlist_lineage_reconciliation_events/);
});

test('readiness invokes reconciliation before outcome and guardrail projection', () => {
  const source = readFileSync(new URL('./readiness.ts', import.meta.url), 'utf8');
  const reconcile = source.indexOf('await reconcileCreatorPlaylistLineage(cutoffAt)');
  const outcomes = source.indexOf('await projectShadowCreatorOutcomes(cutoffAt)');
  const guardrails = source.indexOf('await projectShadowGuardrails(');
  assert.ok(reconcile >= 0 && reconcile < outcomes && reconcile < guardrails);
  assert.match(source, /playlistLineageReconciliation: playlistLineage\.result/);
});
