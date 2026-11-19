import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildAdjudicatorDeferralJob } from './ingestionPipeline';
import type { IngestionCandidate } from './ingestionPipeline';
import type { DiscoverySource } from '../src/types';

const candidate: IngestionCandidate = {
  channelId: 'UCadjudicator000000000000',
  channelName: 'Deferred Trader',
  youtubeUrl: 'https://youtube.com/channel/UCadjudicator000000000000',
  description: 'Trading education',
  videoTitles: ['Gold setup'],
  enrichmentStage: 2,
  adjudicatorDeferralAttempts: 1,
  adjudicatorFirstDeferredAt: '2026-11-01T00:00:00.000Z',
};

test('adjudicator deferral keeps the stage and records durable retry fields', () => {
  const now = '2026-11-19T12:00:00.000Z';
  const built = buildAdjudicatorDeferralJob({
    candidate,
    targetCountry: 'US',
    source: 'automated_query' as DiscoverySource,
    currentStage: 2,
    now,
    priority: 12,
  });
  assert.equal(built.retry.attempts, 2);
  assert.equal(built.retry.firstDeferredAt, Date.parse(candidate.adjudicatorFirstDeferredAt!));
  assert.equal(built.payload.enrichmentStage, 2);
  assert.equal(built.payload.adjudicatorDeferralAttempts, 2);
  assert.equal(built.payload.adjudicatorFirstDeferredAt, candidate.adjudicatorFirstDeferredAt);
  assert.equal(built.payload.adjudicatorDeferralReason, 'PRECISION_ADJUDICATOR_UNAVAILABLE_DEFERRED');
  assert.equal(built.options.runAfter, new Date(Date.parse(now) + 5 * 60_000).toISOString());
  assert.equal(built.options.idempotencyKey, `adjudicator-deferral:${candidate.channelId}:2`);
  assert.equal((built.payload.candidate as IngestionCandidate).adjudicatorDeferralAttempts, 2);
});

test('the pipeline bypasses review/stage exhaustion and the queue carries retry bookkeeping', () => {
  const ingestion = readFileSync(new URL('./ingestionPipeline.ts', import.meta.url), 'utf8');
  const queue = readFileSync(new URL('./queueManager.ts', import.meta.url), 'utf8');
  const db = readFileSync(new URL('./dbCore.ts', import.meta.url), 'utf8');
  assert.match(ingestion, /buildAdjudicatorDeferralJob\(/);
  assert.match(ingestion, /adjudicatorDeferred/);
  assert.match(ingestion, /return deferAdjudicatorUnavailableClassification\(/);
  assert.match(ingestion, /runAfter: nextRetryAt|runAfter: built\.options|buildAdjudicatorDeferralJob/);
  assert.match(queue, /adjudicatorDeferralAttempts/);
  assert.match(queue, /enriched\.adjudicatorFirstDeferredAt=candidate\.adjudicatorFirstDeferredAt/);
  assert.match(db, /getAdjudicatorDeferralMetrics/);
  assert.match(db, /payload->>'adjudicatorDeferralReason'/);
});
