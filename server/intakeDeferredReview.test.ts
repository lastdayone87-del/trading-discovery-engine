import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { computeEvaluationBreakdown, computeEvaluationMetrics, type HumanEvaluationSample } from './intakeDeferredReview';

const fixture = JSON.parse(readFileSync(new URL('./fixtures/humanEvaluationSeed.json', import.meta.url), 'utf8')) as Array<Record<string, any>>;
const samples: HumanEvaluationSample[] = fixture.map(sample => ({
  sampleKey: sample.sampleKey,
  channelId: sample.channelId,
  stratum: sample.stratum,
  systemStatus: sample.systemStatus,
  systemPrediction: sample.systemPrediction,
  humanLabel: sample.humanLabel,
  humanConfidence: sample.humanConfidence,
  language: sample.language,
  country: sample.country,
  metadataQuality: sample.metadataQuality,
  evidenceSnapshot: sample.evidence,
  reviewer: sample.reviewer,
  notes: sample.notes,
  decidedAt: '2026-11-10T00:00:00.000Z',
}));

test('human-verified fixture covers every admission status and does not force ambiguous labels', () => {
  const strata = new Set(samples.map(sample => sample.stratum));
  for (const status of ['TRADING_CONFIRMED', 'NON_TRADING', 'NEEDS_REVIEW', 'UNCERTAIN', 'INTAKE_DEFERRED']) {
    assert.ok(strata.has(status), `fixture must include ${status}`);
  }
  const ambiguous = samples.filter(sample => sample.humanLabel === 'AMBIGUOUS');
  assert.ok(ambiguous.length > 0);
  const covered = computeEvaluationMetrics(samples);
  assert.equal(covered.samples, samples.length);
  assert.equal(covered.ambiguous, ambiguous.length);
  assert.equal(covered.tp + covered.fp + covered.tn + covered.fn + covered.ambiguous + covered.abstained, samples.length);
});

test('fixture metrics expose precision, recall, FPR and FNR without forcing abstentions', () => {
  const metrics = computeEvaluationMetrics(samples);
  assert.ok(metrics.tp > 0 && metrics.tn > 0);
  assert.equal(metrics.fp, 0);
  assert.equal(metrics.fn, 0);
  assert.equal(metrics.precision, 1);
  assert.equal(metrics.recall, 1);
  assert.equal(metrics.falsePositiveRate, 0);
  assert.equal(metrics.falseNegativeRate, 0);
  assert.ok(metrics.coverage > 0 && metrics.coverage < 1);
  const languages = computeEvaluationBreakdown(samples, 'language');
  assert.ok(languages.length >= 2);
});

test('deferred review migration and decision path preserve human evidence and labels', () => {
  const migration = readFileSync(new URL('./db/migrations/173_intake_deferred_review.sql', import.meta.url), 'utf8');
  assert.match(migration, /CREATE TABLE IF NOT EXISTS intake_deferred_reviews/);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS intake_deferred_review_decisions/);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS human_evaluation_samples/);
  assert.match(migration, /human_label TEXT NOT NULL/);
  assert.match(migration, /INSERT INTO intake_deferred_reviews/);
  assert.match(migration, /c\.scan_status='INTAKE_DEFERRED'/);
  assert.match(migration, /ON CONFLICT\(channel_id\) DO NOTHING/);
  const module = readFileSync(new URL('./intakeDeferredReview.ts', import.meta.url), 'utf8');
  assert.match(module, /idempotency_key/);
  assert.match(module, /human_evaluation_samples/);
  assert.match(module, /intake-review-enrich/);
  const pipeline = readFileSync(new URL('./ingestionPipeline.ts', import.meta.url), 'utf8');
  assert.match(pipeline, /recordIntakeDeferredReview/);
  const ui = readFileSync(new URL('../src/components/IntakeDeferredReview.tsx', import.meta.url), 'utf8');
  assert.match(ui, /api\/intake-deferred/);
  assert.match(ui, /Save human decision/);
});

test('deferred evidence sweep is bounded, deduplicated and retry-safe', () => {
  const source = readFileSync(new URL('./intakeDeferredSweep.ts', import.meta.url), 'utf8');
  assert.match(source, /LIMIT \$1/);
  assert.match(source, /pg_try_advisory_lock/);
  assert.match(source, /NOT EXISTS/);
  assert.match(source, /intake-recheck:\$\{channelId\}/);
  assert.match(source, /next_recheck_at=now\(\)\+interval '1 hour'/);
  assert.match(source, /country_status='LIKELY'/);
  assert.match(source, /result\.status === 'REJECTED'/);
});

test('binary metrics count false positives and false negatives without hiding abstentions', () => {
  const make = (humanLabel: 'TRADING' | 'NON_TRADING' | 'AMBIGUOUS', systemPrediction: 'TRADING' | 'NON_TRADING' | 'ABSTAIN'): HumanEvaluationSample => ({
    sampleKey: `${humanLabel}-${systemPrediction}-${Math.random()}`,
    channelId: null,
    stratum: 'UNIT',
    systemStatus: null,
    systemPrediction,
    humanLabel,
    humanConfidence: 'HIGH',
    language: 'en',
    country: 'US',
    metadataQuality: 'RICH',
    evidenceSnapshot: {},
    reviewer: 'unit-test',
    notes: null,
    decidedAt: '2026-11-10T00:00:00.000Z',
  });
  const metrics = computeEvaluationMetrics([
    make('TRADING', 'TRADING'),
    make('TRADING', 'TRADING'),
    make('NON_TRADING', 'TRADING'),
    make('NON_TRADING', 'NON_TRADING'),
    make('TRADING', 'NON_TRADING'),
    make('TRADING', 'ABSTAIN'),
    make('TRADING', 'ABSTAIN'),
    make('AMBIGUOUS', 'TRADING'),
  ]);
  assert.deepEqual(
    { tp: metrics.tp, fp: metrics.fp, tn: metrics.tn, fn: metrics.fn, abstained: metrics.abstained, ambiguous: metrics.ambiguous },
    { tp: 2, fp: 1, tn: 1, fn: 1, abstained: 2, ambiguous: 1 },
  );
  assert.equal(metrics.precision, 0.6667);
  assert.equal(metrics.recall, 0.6667);
  assert.equal(metrics.falsePositiveRate, 0.5);
  assert.equal(metrics.falseNegativeRate, 0.3333);
  assert.equal(metrics.coverage, 0.625);
  const byLanguage = computeEvaluationBreakdown([make('TRADING', 'TRADING')], 'language');
  assert.equal(byLanguage[0].value, 'en');
  assert.equal(byLanguage[0].precision, 1);
});

test('deferred recheck uses the durable ENRICH carrier with bounded stage-1 evidence', () => {
  const worker = readFileSync(new URL('./queueManager.ts', import.meta.url), 'utf8');
  assert.match(worker, /job\.payload\.intakeRecheck === true/);
  assert.match(worker, /processIntakeDeferredRecheckJob/);
  assert.match(worker, /fetchYouTubeChannelEnrichment\(channelId, candidate, 1/);
  assert.match(worker, /units: 2/);
  assert.match(worker, /recheck_attempts: Number\(review\.rows\[0\]\?\.recheck_attempts \|\| 0\) \+ 1/);
  assert.match(worker, /last_evidence_hash/);
  assert.match(worker, /focus\.decision === 'WITHHOLD'/);
  assert.match(worker, /focus\.decision === 'ADMIT'/);
  assert.match(worker, /intake-recheck-enrich:/);
  assert.doesNotMatch(worker, /new pipeline|INTAKE_RECHECK_QUEUE/);
});

test('maintenance scheduler wires bounded deferred and LIKELY-country recovery', () => {
  const scheduler = readFileSync(new URL('./operationalMaintenanceScheduler.ts', import.meta.url), 'utf8');
  assert.match(scheduler, /sweepIntakeDeferredReviews/);
  assert.match(scheduler, /reconcileLikelyExcludedCountryCandidates/);
  assert.match(scheduler, /intake_deferred_evidence_sweep/);
  assert.match(scheduler, /likely_excluded_country_reconciliation/);
  assert.match(scheduler, /sweepIntakeDeferredReviews\(\{ limit: 10, minAgeMinutes: 60 \}\)/);
  assert.match(scheduler, /reconcileLikelyExcludedCountryCandidates\(\{ limit: 20 \}\)/);
});

test('review and evaluation routes are reviewer-protected and registered', () => {
  const server = readFileSync(new URL('../server.ts', import.meta.url), 'utf8');
  assert.match(server, /app\.get\('\/api\/intake-deferred'/);
  assert.match(server, /app\.get\('\/api\/intake-deferred\/:channelId'/);
  assert.match(server, /app\.post\('\/api\/intake-deferred\/:channelId\/decision'/);
  assert.match(server, /app\.get\('\/api\/human-evaluation\/samples'/);
  assert.match(server, /app\.get\('\/api\/human-evaluation\/metrics'/);
  const auth = readFileSync(new URL('./operatorAuth.ts', import.meta.url), 'utf8');
  assert.match(auth, /intake-deferred/);
  assert.match(auth, /human-evaluation\\\/samples/);
  assert.match(auth, /intake-deferred\\\/\[\^\/\]\+\\\/decision/);
});

test('review UI preserves system reasoning separately from human decisions', () => {
  const ui = readFileSync(new URL('../src/components/IntakeDeferredReview.tsx', import.meta.url), 'utf8');
  for (const field of ['reviewerHeaders', 'Idempotency-Key', 'reviewVersion', 'systemSnapshot', 'evidenceSnapshot', 'inspectionTrail', 'history']) {
    assert.ok(ui.includes(field), `UI must expose ${field}`);
  }
  assert.match(ui, /This is not the label/);
  assert.match(ui, /TRADING returns the channel to normal enrichment/);
  assert.match(ui, /NON_TRADING/);
  assert.match(ui, /AMBIGUOUS/);
  assert.match(ui, /videoTitles/);
  assert.match(ui, /Corrected country/);
  assert.match(ui, /Corrected language/);
});

test('LIKELY excluded-country recheck never feeds the weak stored country back as proof', () => {
  const source = readFileSync(new URL('./intakeDeferredSweep.ts', import.meta.url), 'utf8');
  assert.match(source, /locationTag: candidate\.locationTag \|\| undefined/);
  assert.doesNotMatch(source, /locationTag: candidate\.locationTag \|\| row\.country/);
  assert.match(source, /CLASSIFY_DISCOVERED_CHANNEL/);
  assert.match(source, /'COMPLETED','FAILED','FAILED_PERMANENT','SKIPPED_LOW_AUDIENCE'/);
  assert.match(source, /Country Recheck/);
  assert.match(source, /state='SUPERSEDED'/);
  assert.match(source, /result\.status === 'CONFIRMED' && detected && result\.gateDisposition === 'ALLOW_NORMAL'/);
});
