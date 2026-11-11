import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { buildAdmissionConfirmedClassification } from './confirmedTrading';

const pipeline = readFileSync(new URL('../ingestionPipeline.ts', import.meta.url), 'utf8');
const queue = readFileSync(new URL('../queueManager.ts', import.meta.url), 'utf8');
const dbCore = readFileSync(new URL('../dbCore.ts', import.meta.url), 'utf8');
const queryIntelligence = readFileSync(new URL('../queryIntelligence.ts', import.meta.url), 'utf8');

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
    },
  );
  assert.equal(built.result.status, 'TRADING_CONFIRMED');
  assert.equal(built.decision.status, 'TRADING_CONFIRMED');
  assert.equal(built.decision.classificationMethod, 'SEMANTIC_ADMISSION');
  assert.equal(built.decision.recognitionState, 'DECISIVE_TRADING');
  assert.equal(built.decision.confidenceScore, 93);
});

test('pipeline source wires a confirmed admission to the synthetic classifier', () => {
  assert.match(pipeline, /candidate\.admissionDecisionId/);
  assert.match(pipeline, /candidate\.admissionConfirmedTrading === true && candidate\.admissionDecisionId/);
  assert.match(pipeline, /buildAdmissionConfirmedClassification/);
  assert.match(pipeline, /Boolean\(candidate\.admissionDecisionId\)/);
  const gate = queue.indexOf("if (!options?.admissionBypass && (await getAdmissionMode()) === 'ACTIVE')");
  const legacyHandoff = queue.indexOf('return processChannelThroughPipeline(raw, targetCountry, source, false, false, options);');
  assert.ok(gate > -1 && legacyHandoff > gate, 'the admission gate must precede the legacy pipeline handoff');
});

test('legacy dashboard predicate hides pre-admission rows', () => {
  assert.match(dbCore, /scan_status <> 'INTAKE_DEFERRED'/);
  assert.match(dbCore, /scan_status <> 'CLASSIFICATION_PENDING'/);
});

test('search-worker source contract wires admission before classification and stores matched document', () => {
  assert.match(queue, /upsertAdmissionCandidate/);
  assert.match(queue, /enqueueAdmissionVerification/);
  assert.match(queue, /VERIFY_CHANNEL_ADMISSION/);
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
  assert.match(queue, /processDiscoveredChannel\([\s\S]*?getAdmissionMode/);
  assert.match(queue, /admissionBypass/);
  assert.match(queue, /admissionSemanticClaimable/);
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
