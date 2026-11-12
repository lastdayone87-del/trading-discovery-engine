import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { buildAdmissionConfirmedClassification } from './confirmedTrading';

const pipeline = readFileSync(new URL('../ingestionPipeline.ts', import.meta.url), 'utf8');
const queue = readFileSync(new URL('../queueManager.ts', import.meta.url), 'utf8');
const dbCore = readFileSync(new URL('../dbCore.ts', import.meta.url), 'utf8');
const queryIntelligence = readFileSync(new URL('../queryIntelligence.ts', import.meta.url), 'utf8');

function functionSource(source: string, name: string): string {
  const start = source.indexOf(`export async function ${name}(`);
  if (start < 0) return '';
  const next = source.indexOf('\nexport ', start + 10);
  return source.slice(start, next < 0 ? undefined : next);
}

test('confident admission produces a first-class TRADING_CONFIRMED result without #618 re-decision', () => {
  const built = buildAdmissionConfirmedClassification(
    { channel_name: 'Confirmed Trader', description: 'technical analysis and price action', country: 'United Arab Emirates' },
    {
      channelId: 'UC-confirmed',
      channelName: 'Confirmed Trader',
      youtubeUrl: 'https://youtube.com/channel/UC-confirmed',
      description: 'technical analysis and price action',
      videoTitles: ['Gold analysis'],
      admissionDecisionId: 'decision-1',
      admissionStatus: 'ADMITTED',
      admissionConfirmedTrading: true,
      admissionTradingConfidence: 93,
      admissionCategory: 'General Trading',
      admissionModel: 'gemini/gemini-3.8-flash',
      admissionProvider: 'gemini_semantic',
      admissionCitations: [
        { field: 'bio', quote: 'technical analysis and price action', supports: 'TRADING' },
        { field: 'video_title', index: 0, quote: 'Gold analysis', supports: 'TRADING' },
      ],
    },
  );
  assert.equal(built.result.status, 'TRADING_CONFIRMED');
  assert.equal(built.decision.status, 'TRADING_CONFIRMED');
  assert.equal(built.decision.classificationMethod, 'SEMANTIC_ADMISSION');
  assert.equal(built.decision.recognitionState, 'DECISIVE_TRADING');
  assert.equal(built.decision.confidenceScore, 93);
});

test('confirmed admission branch precedes the legacy classifier in the pipeline slice', () => {
  const start = pipeline.indexOf('const admissionShortcut =');
  const end = pipeline.indexOf('const classificationRouting = productionClassification.decision.deterministicRouting;', start);
  assert.ok(start > -1 && end > start, 'classification branch must exist');
  const slice = pipeline.slice(start, end);
  const confirmed = slice.indexOf('candidate.admissionConfirmedTrading === true');
  const classifier = slice.indexOf('await classifyTradingRelevanceDetailed(classifierInput)');
  assert.ok(confirmed > -1 && classifier > confirmed, 'confirmed admission must be selected before the legacy classifier');
  assert.match(slice, /buildAdmissionConfirmedClassification/);
  assert.match(slice, /getAdmissionMode\(\)\) === 'ACTIVE'/);
});

test('legacy dashboard predicate hides pre-admission rows', () => {
  assert.match(dbCore, /scan_status <> 'INTAKE_DEFERRED'/);
  assert.match(dbCore, /scan_status <> 'CLASSIFICATION_PENDING'/);
});

test('search-worker admission path stores the sighting and never falls through to the pipeline', () => {
  const admit = functionSource(queue, 'admitDiscoveredChannel');
  assert.ok(admit.length > 0, 'admitDiscoveredChannel must exist');
  assert.match(admit, /upsertAdmissionCandidate/);
  assert.match(admit, /enqueueAdmissionVerification/);
  assert.match(admit, /pending: true/);
  assert.ok(!admit.includes('processChannelThroughPipeline'), 'admission must not fall through to the ungated pipeline');
  assert.match(queue, /matchedDocument: raw\.matchedDocument \|\| null/);
  assert.match(queue, /getAdmissionPageOutcomes/);
  assert.match(queue, /evaluateQueryAdmissionGuard/);
  assert.match(queue, /quarantineQuery\(queryId, admissionGuard\.reasonCodes\)/);
});

test('extracted query offer uses the trading-anchor/gambling guard', () => {
  assert.match(queryIntelligence, /assessExtractedQueryAdmission/);
  assert.match(queryIntelligence, /sourceTitle: candidate\.sourceTitle/);
});

test('query guard and revalidation are wired as first-class components', () => {
  const revalidation = readFileSync(new URL('../../scripts/revalidateIntakeDeferredChannels.ts', import.meta.url), 'utf8');
  assert.match(revalidation, /verifyAdmissionCandidate/);
  assert.match(revalidation, /archiveRejectedExistingChannel: apply/);
  assert.match(revalidation, /dryRun: !apply/);
  assert.match(revalidation, /intake_deferred_revalidation_summary/);
});

test('all discovery sources pass the admission gate and admission honors the kill switch', () => {
  const shared = functionSource(queue, 'processDiscoveredChannel');
  const admission = functionSource(queue, 'admitDiscoveredChannel');
  assert.ok(shared.length > 0 && admission.length > 0);
  assert.match(shared, /getAdmissionMode/);
  assert.match(shared, /admissionBypass/);
  assert.match(shared, /upsertAdmissionCandidate/);
  const gate = shared.indexOf("if (!options?.admissionBypass && (await getAdmissionMode()) === 'ACTIVE')");
  const legacyHandoff = shared.indexOf('return processChannelThroughPipeline(raw, targetCountry, source, false, false, options);');
  assert.ok(gate > -1 && legacyHandoff > gate, 'the admission gate must precede the legacy pipeline handoff');
  assert.match(queue, /admissionModeActive = \(await getAdmissionMode\(\)\) === 'ACTIVE'/);
  assert.match(queue, /admissionSemanticClaimable = admissionModeActive && await admissionSemanticRouteHealthy\(\)/);
  const worker = readFileSync(new URL('./worker.ts', import.meta.url), 'utf8');
  assert.match(worker, /getAdmissionMode\(\)\) === 'OFF'/);
});

test('legacy apply is guarded against unstable paging and silent failures', () => {
  const revalidation = readFileSync(new URL('../../scripts/revalidateIntakeDeferredChannels.ts', import.meta.url), 'utf8');
  assert.match(revalidation, /APPLY_REQUIRES_OFFSET_ZERO/);
  assert.match(revalidation, /INVALID_LIMIT/);
  assert.match(revalidation, /process\.exitCode = 1/);
  assert.match(revalidation, /target-country/);
  assert.match(revalidation, /getChannelById\(row\.channel_id\)/);
});

test('confirmed admission carries citations and flags missing confidence for review', () => {
  const withProvenance = buildAdmissionConfirmedClassification(
    { channel_name: 'Cited Trader', description: 'technical analysis' },
    {
      channelId: 'UC-cited',
      channelName: 'Cited Trader',
      youtubeUrl: 'https://youtube.com/channel/UC-cited',
      description: 'technical analysis',
      videoTitles: ['Gold analysis'],
      admissionDecisionId: 'decision-2',
      admissionStatus: 'ADMITTED',
      admissionConfirmedTrading: true,
      admissionTradingConfidence: 88,
      admissionCategory: 'General Trading',
      admissionModel: 'openai/gpt-oss-120b',
      admissionProvider: 'groq_semantic',
      admissionCitations: [
        { field: 'bio', quote: 'technical analysis', supports: 'TRADING' },
        { field: 'video_title', index: 0, quote: 'Gold analysis', supports: 'TRADING' },
      ],
    },
  );
  assert.equal(withProvenance.decision.confidenceScore, 88);
  assert.equal(withProvenance.decision.positiveEvidence.length, 2);
  assert.equal(withProvenance.decision.evidenceCollection.sufficiency, 'SUFFICIENT');
  assert.equal(withProvenance.decision.evidenceCollection.providers[0].provider, 'groq_semantic');
  assert.equal(withProvenance.decision.deterministicRouting?.humanReview, false);

  const missingConfidence = buildAdmissionConfirmedClassification(
    { channel_name: 'No Score', description: 'technical analysis' },
    {
      channelId: 'UC-no-score',
      channelName: 'No Score',
      youtubeUrl: 'https://youtube.com/channel/UC-no-score',
      description: 'technical analysis',
      videoTitles: [],
      admissionDecisionId: 'decision-3',
      admissionStatus: 'ADMITTED',
      admissionConfirmedTrading: true,
    },
  );
  assert.equal(missingConfidence.decision.confidenceScore, 0);
  assert.equal(missingConfidence.decision.status, 'UNCERTAIN');
  assert.equal(missingConfidence.result.status, 'UNCERTAIN');
  assert.equal(missingConfidence.decision.evidenceCollection.sufficiency, 'INSUFFICIENT');
  assert.equal(missingConfidence.decision.deterministicRouting?.humanReview, true);
});
