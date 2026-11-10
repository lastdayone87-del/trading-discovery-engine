import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  computeEvaluationBreakdown,
  computeEvaluationMetrics,
  normalizeHumanEvaluationSamples,
  type HumanEvaluationSample,
} from './intakeDeferredReview';

const fixture = JSON.parse(readFileSync(new URL('./fixtures/humanEvaluationSeed.json', import.meta.url), 'utf8'));
const samples: HumanEvaluationSample[] = normalizeHumanEvaluationSamples(fixture);

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

test('fixture validation rejects unknown enums instead of silently dropping rows', () => {
  const broken = structuredClone(fixture) as Array<Record<string, any>>;
  broken[0].humanLabel = 'MAYBE';
  assert.throws(() => normalizeHumanEvaluationSamples(broken), /HUMAN_EVALUATION_FIXTURE_INVALID/);
  broken[0].humanLabel = 'TRADING';
  broken[0].systemPrediction = 'BROKEN';
  assert.throws(() => normalizeHumanEvaluationSamples(broken), /HUMAN_EVALUATION_FIXTURE_INVALID/);
  broken[0].systemPrediction = 'ABSTAIN';
  broken[0].decidedAt = '2026-11-10';
  assert.throws(() => normalizeHumanEvaluationSamples(broken), /HUMAN_EVALUATION_FIXTURE_INVALID/);
  broken[0].decidedAt = '2026-02-30T00:00:00.000Z';
  assert.throws(() => normalizeHumanEvaluationSamples(broken), /HUMAN_EVALUATION_FIXTURE_INVALID/);
  broken[0].decidedAt = '2026-11-10T00:00:00.000Z';
  broken[1].sampleKey = broken[0].sampleKey;
  assert.throws(() => normalizeHumanEvaluationSamples(broken), /duplicate sampleKey/);
  const noMillis = structuredClone(fixture) as Array<Record<string, any>>;
  noMillis[0].decidedAt = '2026-11-10T00:00:00Z';
  assert.equal(normalizeHumanEvaluationSamples(noMillis)[0].decidedAt, '2026-11-10T00:00:00.000Z');
  const fractional = structuredClone(fixture) as Array<Record<string, any>>;
  fractional[0].decidedAt = '2026-11-10T00:00:00.5Z';
  assert.equal(normalizeHumanEvaluationSamples(fractional)[0].decidedAt, '2026-11-10T00:00:00.500Z');
  const earlyYear = structuredClone(fixture) as Array<Record<string, any>>;
  earlyYear[0].decidedAt = '0001-01-01T00:00:00Z';
  assert.equal(normalizeHumanEvaluationSamples(earlyYear)[0].decidedAt, '0001-01-01T00:00:00.000Z');
});

test('fixture metrics expose precision, recall, FPR and FNR without forcing abstentions', () => {
  const metrics = computeEvaluationMetrics(samples);
  assert.equal(metrics.tp, 8);
  assert.equal(metrics.fp, 0);
  assert.equal(metrics.tn, 5);
  assert.equal(metrics.fn, 1);
  assert.equal(metrics.ambiguous, 7);
  assert.equal(metrics.abstained, 15);
  assert.equal(metrics.precision, 1);
  assert.equal(metrics.recall, 0.8889);
  assert.equal(metrics.falsePositiveRate, 0);
  assert.equal(metrics.falseNegativeRate, 0.1111);
  assert.equal(metrics.coverage, 0.3889);
  const languages = computeEvaluationBreakdown(samples, 'language');
  assert.ok(languages.length >= 2);
});

test('deferred review migration and decision path preserve human evidence and labels', () => {
  const migration = readFileSync(new URL('./db/migrations/175_intake_deferred_review.sql', import.meta.url), 'utf8');
  assert.match(migration, /CREATE TABLE IF NOT EXISTS intake_deferred_reviews/);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS intake_deferred_review_decisions/);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS human_evaluation_samples/);
  assert.match(migration, /human_label TEXT NOT NULL/);
  assert.match(migration, /INSERT INTO intake_deferred_reviews/);
  assert.match(migration, /c\.scan_status='INTAKE_DEFERRED'/);
  assert.match(migration, /ON CONFLICT\(channel_id\) DO NOTHING/);
  assert.match(migration, /intake_deferred_review_decisions_immutable/);
  assert.match(migration, /GREATEST\(/);
  const module = readFileSync(new URL('./intakeDeferredReview.ts', import.meta.url), 'utf8');
  assert.match(module, /idempotency_key/);
  assert.match(module, /human_evaluation_samples/);
  assert.match(module, /intake-review-enrich/);
  assert.match(module, /Re-check the idempotency key under the lock/);
  assert.match(module, /language=COALESCE\(NULLIF\(\$8,''\),language\)/);
  assert.match(module, /intake_deferred_reviews\.state='SUPERSEDED'/);
  assert.match(module, /c\.scan_status='INTAKE_DEFERRED'/);
  assert.match(module, /review_version\+1/);
  assert.match(module, /channel\.country_status === 'CONFIRMED'/);
  assert.match(module, /Idempotency key was already used for a different decision/);
  const cancelJobs = module.indexOf("UPDATE jobs SET status='FAILED'");
  const lockRows = module.indexOf('FOR UPDATE OF r,c');
  assert.ok(cancelJobs >= 0 && lockRows > cancelJobs, 'NON_TRADING job cancellation must precede the review/channel lock');
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
  assert.match(source, /FOR UPDATE OF r/);
  assert.match(source, /review_version=\$3/);
  assert.match(source, /next_recheck_at=now\(\)\+\(\$2::text\|\|' minutes'\)::interval/);
  assert.match(source, /SKIPPED_LOW_AUDIENCE/);
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
  assert.match(worker, /review_version=CASE WHEN \$9::boolean/);
  const gate = worker.indexOf('const storedExclusion = await getCountryExclusion(channel.country)');
  const reserve = worker.indexOf("reserved = await tryReserveQuota({", gate);
  assert.ok(gate >= 0 && reserve > gate, 'country and low-audience gates must run before recheck quota reservation');
  assert.match(worker, /shouldBlockEnrichClaimForCountry\(channel\.country_status/);
  assert.match(worker, /evaluateLowAudienceGate\(recheckAudience/);
  assert.match(worker, /SKIPPED_LOW_AUDIENCE[\s\S]*state='SUPERSEDED'/);
  assert.match(worker, /clientOverride: admitClient/);
  const admitCleanup = worker.indexOf("await finishQuotaReservation('ENRICH_CHANNEL', job.id, true)");
  assert.ok(admitCleanup >= 0, 'early ADMIT returns must settle the quota reservation');
  const audienceLock = worker.indexOf('SELECT 1 FROM intake_deferred_reviews WHERE channel_id=$1 FOR UPDATE');
  const audienceUpdate = worker.indexOf("scan_status='SKIPPED_LOW_AUDIENCE'");
  assert.ok(audienceLock >= 0 && audienceUpdate > audienceLock, 'low-audience review row must be locked before the channel update');
  assert.match(worker, /focus\.decision === 'WITHHOLD'/);
  assert.match(worker, /focus\.decision === 'ADMIT'/);
  assert.match(worker, /intake-recheck-enrich:/);
  assert.match(worker, /SKIPPED_NON_TRADING/);
  assert.match(worker, /job\.payload\?\.intakeRecheck === true/);
  assert.match(worker, /channel\.scan_status === 'INTAKE_DEFERRED'/);
  assert.match(worker, /matchedDocument: enriched\.matchedDocument/);
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
  assert.match(server, /offset \+= page\.length/);
  assert.match(server, /const requestedState = String\(req\.query\.state/);
  assert.match(server, /state,/);
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
  assert.match(ui, /stateFilter/);
  assert.match(ui, /selected\.state !== 'PENDING'/);
  assert.match(ui, /X-Reviewer-Id/);
  assert.match(ui, /newRequestId\(\)/);
  assert.match(ui, /selectionRequest/);
  assert.match(ui, /submittedToken/);
  assert.match(ui, /loading \|\| selected\.state !== 'PENDING'/);
  assert.doesNotMatch(ui, /Authorization: `Bearer \$\{token\}`/);
});

test('LIKELY excluded-country recheck never feeds the weak stored country back as proof', () => {
  const source = readFileSync(new URL('./intakeDeferredSweep.ts', import.meta.url), 'utf8');
  assert.match(source, /locationTag: candidate\.locationTag \|\| undefined/);
  assert.doesNotMatch(source, /locationTag: candidate\.locationTag \|\| row\.country/);
  assert.match(source, /CLASSIFY_DISCOVERED_CHANNEL/);
  assert.match(source, /'COMPLETED','FAILED','FAILED_PERMANENT','SKIPPED_LOW_AUDIENCE'/);
  assert.match(source, /Country Recheck/);
  assert.match(source, /state='SUPERSEDED'/);
  assert.match(source, /args\.result\.status === 'CONFIRMED' && args\.detected && args\.result\.gateDisposition === 'ALLOW_NORMAL'/);
  assert.match(source, /snapshotReviewVersion/);
  assert.match(source, /FOR UPDATE OF r,c/);
  assert.match(source, /String\(row\.country \|\| ''\) !== String\(args\.snapshotCountry/);
});
