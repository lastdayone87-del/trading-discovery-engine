import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { buildAdmissionConfirmedClassification, normalizeAdmissionTradingConfidence } from './confirmedTrading';
import { normalizeTradingFocus } from './confidence';
import { normalizeSemanticJudgment } from './policy';
import { admissionEvidenceExpired, isPreCatalogProviderDeferredDecision, nextAdmissionEvidenceAttempt, parseAdmissionReviewAction } from './index';
import { classificationStageForCandidate } from '../youtube';
import { admissionShortcutEligible } from '../ingestionPipeline';
import { hasAiLedTradingConfirmation } from '../evidenceEngine/decisionPolicy';

const pipeline = readFileSync(new URL('../ingestionPipeline.ts', import.meta.url), 'utf8');
const queue = readFileSync(new URL('../queueManager.ts', import.meta.url), 'utf8');
const index = readFileSync(new URL('./index.ts', import.meta.url), 'utf8');
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

test('fractional semantic admission confidence is normalized to an integer percentage', () => {
  assert.equal(normalizeAdmissionTradingConfidence(0.9), 90);
  assert.equal(normalizeAdmissionTradingConfidence(0.85), 85);
  assert.equal(normalizeAdmissionTradingConfidence(0.95), 95);
  assert.equal(normalizeAdmissionTradingConfidence(0.5), 50);
  assert.equal(normalizeAdmissionTradingConfidence(0.01), 1);
  assert.equal(normalizeAdmissionTradingConfidence(85.5), 86);
  assert.equal(normalizeAdmissionTradingConfidence(1), 1, 'exactly 1 on the percentage scale must not become 100');
  assert.equal(normalizeAdmissionTradingConfidence(93), 93);
  assert.equal(normalizeAdmissionTradingConfidence(0), 0);
  assert.equal(normalizeAdmissionTradingConfidence(150), 100);
  assert.equal(normalizeAdmissionTradingConfidence('0.85'), 85);
  assert.equal(normalizeAdmissionTradingConfidence(''), 0);
  assert.equal(normalizeAdmissionTradingConfidence(undefined), 0);
  assert.equal(normalizeAdmissionTradingConfidence(true), 0);
  assert.equal(normalizeAdmissionTradingConfidence([0.9]), 0);
  assert.equal(normalizeAdmissionTradingConfidence({ value: 0.9 }), 0);

  const built = buildAdmissionConfirmedClassification(
    { channel_name: 'Fractional Trader', description: 'gold technical analysis', country: 'France' },
    {
      channelId: 'UC-fractional',
      channelName: 'Fractional Trader',
      youtubeUrl: 'https://youtube.com/channel/UC-fractional',
      description: 'gold technical analysis',
      videoTitles: ['Gold weekly analysis'],
      admissionDecisionId: 'decision-fractional',
      admissionStatus: 'ADMITTED',
      admissionConfirmedTrading: true,
      admissionTradingConfidence: 0.9,
      admissionCategory: 'General Trading',
      admissionModel: 'gemini/gemini-3.6-flash',
      admissionProvider: 'gemini_semantic',
      admissionCitations: [
        { field: 'bio', quote: 'gold technical analysis', supports: 'TRADING' },
        { field: 'video_title', index: 0, quote: 'Gold weekly analysis', supports: 'TRADING' },
      ],
    },
  );
  assert.equal(built.result.confidenceScore, 90);
  assert.equal(built.decision.confidenceScore, 90);
  assert.ok(Number.isInteger(built.result.confidenceScore));
  assert.ok(Number.isInteger(built.decision.confidenceScore));
});

test('semantic judgment focus is normalized before policy thresholds', () => {
  assert.equal(normalizeTradingFocus(0.9, 'TRADING'), 90);
  assert.equal(normalizeTradingFocus(0.9, 'MIXED'), 90);
  assert.equal(normalizeTradingFocus(0.9, 'UNRELATED'), 1, 'an unrelated low focus must stay low');
  assert.equal(normalizeTradingFocus(0.9, 'FINANCE_ADJACENT'), 1);
  assert.equal(normalizeTradingFocus(1, 'TRADING'), 1);
  assert.equal(normalizeTradingFocus(85.5, 'TRADING'), 86);

  const trading = normalizeSemanticJudgment({
    main_subject: 'TRADING',
    trading_focus: 0.9,
    evidence_citations: [],
  });
  assert.equal(trading?.tradingFocus, 90);
  const unrelated = normalizeSemanticJudgment({
    main_subject: 'UNRELATED',
    trading_focus: 0.9,
    unrelated_domains: [{ domain: 'COOKING', confidence: 0.9 }],
    evidence_citations: [],
  });
  assert.equal(unrelated?.tradingFocus, 1);
});

test('confirmed admission branch precedes the legacy classifier in the pipeline slice', () => {
  const start = pipeline.indexOf('const admissionShortcut =');
  const end = pipeline.indexOf('const classificationRouting = productionClassification.decision.deterministicRouting;', start);
  assert.ok(start > -1 && end > start, 'classification branch must exist');
  const slice = pipeline.slice(start, end);
  const confirmed = slice.indexOf('admissionShortcutEligible(candidate');
  const classifier = slice.indexOf('await classifyTradingRelevanceDetailed(classifierInput)');
  assert.ok(confirmed > -1 && classifier > confirmed, 'confirmed admission must be selected before the full classifier');
  assert.match(slice, /buildAdmissionConfirmedClassification/);
  assert.match(slice, /admissionShortcutEligible\(candidate, await getAdmissionMode\(\)\)/);
  assert.match(pipeline, /admissionDecisionSource === 'DETERMINISTIC'/);
  assert.match(pipeline, /admissionDecisionSource === 'HUMAN'/);
  assert.match(pipeline, /ADMISSION_CONFIRMATION_MIN_CONFIDENCE/);
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
  const pageGuardBlock = queue.slice(
    queue.indexOf('const [admissionOutcomes'),
    queue.indexOf('// Pending admission verdicts'),
  );
  assert.ok(pageGuardBlock.length > 0, 'normal-page admission guard block must exist');
  for (const expected of [
    'getAutonomousRunSettledYield(',
    'outcomes: admissionPageOutcomes,',
    'runQualityChannels: admissionRunYield?.qualityChannels,',
    'runTradingConfirmed: admissionRunYield?.tradingConfirmed,',
    'runClassificationPending: admissionRunYield?.classificationPending,',
    'runYieldAvailable: admissionRunYield !== null,',
    'priorQueryRuns:',
    'priorQueryQualityChannels:',
    'priorQueryUniqueChannels:',
  ]) {
    assert.ok(pageGuardBlock.includes(expected), `normal-page guard must include ${expected}`);
  }
  const settledGuardBlock = queue.slice(
    queue.indexOf('const [settledMetrics'),
    queue.indexOf('if (settledGuard.stop'),
  );
  assert.ok(settledGuardBlock.length > 0, 'orphan-recovery admission guard block must exist');
  for (const expected of [
    'getAutonomousRunSettledYield(',
    'outcomes: pageOutcomes,',
    'runQualityChannels: settledRunYield?.qualityChannels,',
    'runTradingConfirmed: settledRunYield?.tradingConfirmed,',
    'runClassificationPending: settledRunYield?.classificationPending,',
    'runYieldAvailable: settledRunYield !== null,',
    'priorQueryQualityChannels:',
    'priorQueryUniqueChannels:',
  ]) {
    assert.ok(settledGuardBlock.includes(expected), `orphan guard must include ${expected}`);
  }
  assert.match(queue, /quarantineQuery\(queryId, admissionGuard\.reasonCodes\)/);
});

test('deterministic admission is a first-class classification without AI provenance', () => {
  const built = buildAdmissionConfirmedClassification(
    { channel_name: 'Deterministic Trader', description: 'technical analysis and price action' },
    {
      channelId: 'UC-deterministic',
      channelName: 'Deterministic Trader',
      youtubeUrl: 'https://youtube.com/channel/UC-deterministic',
      description: 'technical analysis and price action',
      videoTitles: ['Gold analysis'],
      admissionDecisionId: 'decision-det-1',
      admissionStatus: 'ADMITTED',
      admissionConfirmedTrading: true,
      admissionTradingConfidence: 96,
      admissionCategory: 'General Trading',
      admissionDecisionSource: 'DETERMINISTIC',
      admissionCitations: [
        { field: 'bio', quote: 'technical analysis', supports: 'TRADING' },
        { field: 'video_title', index: 0, quote: 'Gold analysis', supports: 'TRADING' },
      ],
    },
  );
  assert.equal(built.result.status, 'TRADING_CONFIRMED');
  assert.equal(built.decision.status, 'TRADING_CONFIRMED');
  assert.equal(built.decision.classificationMethod, 'DETERMINISTIC_EVIDENCE');
  assert.equal(built.decision.evidenceCollection.sufficiency, 'SUFFICIENT');
  assert.equal(built.decision.deterministicRouting?.semanticUsed, false);
  assert.equal(built.decision.deterministicRouting?.semanticAttempted, false);
  assert.equal(built.decision.positiveEvidence[0].source, 'channel_metadata');
});

test('human review admission is a first-class confirmed classification', () => {
  const built = buildAdmissionConfirmedClassification(
    { channel_name: 'Reviewed Trader', description: 'technical analysis' },
    {
      channelId: 'UC-reviewed',
      channelName: 'Reviewed Trader',
      youtubeUrl: 'https://youtube.com/channel/UC-reviewed',
      description: 'technical analysis',
      videoTitles: ['Gold analysis'],
      admissionDecisionId: 'decision-human-1',
      admissionStatus: 'ADMITTED',
      admissionConfirmedTrading: true,
      admissionTradingConfidence: 100,
      admissionCategory: 'General Trading',
      admissionDecisionSource: 'HUMAN',
      admissionCitations: [
        { field: 'bio', quote: 'technical analysis', supports: 'TRADING' },
      ],
    },
  );
  assert.equal(built.result.status, 'TRADING_CONFIRMED');
  assert.equal(built.decision.status, 'TRADING_CONFIRMED');
  assert.equal(built.decision.classificationMethod, 'HUMAN_REVIEW_ADMISSION');
  assert.equal(built.decision.evidenceCollection.sufficiency, 'SUFFICIENT');
  assert.equal(built.decision.deterministicRouting?.semanticUsed, false);
  assert.equal(built.decision.versions.geminiModelVersion, 'human-review-admission-v1');
  assert.deepEqual(built.decision.countryContextUsed.matchedTerms, ['HUMAN_REVIEW_ADMISSION']);
  assert.equal(built.result.breakdown.ai_reviewed, false);

  const lowScoreApproval = buildAdmissionConfirmedClassification(
    { channel_name: 'Reviewed Unknown', description: 'short bio' },
    {
      channelId: 'UC-reviewed-low',
      channelName: 'Reviewed Unknown',
      youtubeUrl: 'https://youtube.com/channel/UC-reviewed-low',
      description: 'short bio',
      videoTitles: [],
      admissionDecisionId: 'decision-human-2',
      admissionStatus: 'ADMITTED',
      admissionConfirmedTrading: true,
      admissionTradingConfidence: 40,
      admissionDecisionSource: 'HUMAN',
      admissionCitations: [],
    },
  );
  assert.equal(lowScoreApproval.result.status, 'TRADING_CONFIRMED');
  assert.equal(lowScoreApproval.decision.recognitionState, 'DECISIVE_TRADING');
});

test('review CLI rejects conflicting actions and maps each action explicitly', () => {
  assert.equal(parseAdmissionReviewAction({ admit: true }), 'ADMIT');
  assert.equal(parseAdmissionReviewAction({ reject: true }), 'REJECT');
  assert.equal(parseAdmissionReviewAction({ requeue: true }), 'REQUEUE');
  assert.equal(parseAdmissionReviewAction({}), null);
  assert.throws(() => parseAdmissionReviewAction({ admit: true, reject: true }), /REVIEW_ACTION_CONFLICT/);
  assert.throws(() => parseAdmissionReviewAction({ admit: true, requeue: true }), /REVIEW_ACTION_CONFLICT/);
});

test('confirmed semantic admission without provider metadata stays confirmed', () => {
  const built = buildAdmissionConfirmedClassification(
    { channel_name: 'Da Stock Analyst', description: '', country: 'Unknown' },
    {
      channelId: 'UC-confirmed-semantic',
      channelName: 'Da Stock Analyst',
      youtubeUrl: 'https://youtube.com/channel/UC-confirmed-semantic',
      description: '',
      videoTitles: ['#STI breakout', '#STI next week'],
      admissionDecisionId: 'decision-semantic-1',
      admissionStatus: 'ADMITTED',
      admissionDecisionSource: 'SEMANTIC',
      admissionConfirmedTrading: true,
      admissionTradingConfidence: 88,
      admissionCategory: 'General Trading',
      admissionModel: 'gemini-3.5-flash-lite',
      admissionCitations: [
        { field: 'channel_title', quote: 'day trading', supports: 'TRADING' },
        { field: 'channel_bio', quote: 'swing trade alerts', supports: 'TRADING' },
      ],
    },
  );
  assert.equal(built.result.status, 'TRADING_CONFIRMED');
  assert.equal(built.decision.status, 'TRADING_CONFIRMED');
  assert.equal(built.decision.deterministicRouting?.humanReview, false);
  assert.equal(built.decision.deterministicRouting?.route, 'SEMANTIC_TRADING');
  assert.equal(built.decision.evidenceCollection.sufficiency, 'SUFFICIENT');
  assert.equal(built.decision.evidenceCollection.providers[0]?.provider, 'admission_decision');
  assert.ok(built.decision.positiveEvidence.some(item => item.source === 'admission_decision'));
});

test('legacy semantic probability boundary normalizes to 100 for a confirmed admission', () => {
  const built = buildAdmissionConfirmedClassification(
    { channel_name: 'Legacy Probability Trader', description: '', country: 'Unknown' },
    {
      channelId: 'UC-legacy-probability',
      channelName: 'Legacy Probability Trader',
      youtubeUrl: 'https://youtube.com/channel/UC-legacy-probability',
      description: '',
      videoTitles: ['Gold analysis'],
      admissionDecisionId: 'decision-legacy-probability',
      admissionStatus: 'ADMITTED',
      admissionDecisionSource: 'SEMANTIC',
      admissionConfirmedTrading: true,
      admissionTradingConfidence: 1,
      admissionCitations: [
        { field: 'bio', quote: 'market sentiment and options strategies', supports: 'TRADING' },
      ],
    },
  );
  assert.equal(built.result.status, 'TRADING_CONFIRMED');
  assert.equal(built.decision.status, 'TRADING_CONFIRMED');
  assert.equal(built.decision.confidenceScore, 100);
  assert.equal(built.decision.deterministicRouting?.humanReview, false);
  assert.equal(built.decision.positiveEvidence[0]?.provenance?.fields?.[0]?.field, 'channel_bio');
});

test('finance-adjacent admission citations do not become AI-led trading evidence', () => {
  const built = buildAdmissionConfirmedClassification(
    { channel_name: 'Finance Adjacent', description: '', country: 'Unknown' },
    {
      channelId: 'UC-finance-adjacent',
      channelName: 'Finance Adjacent',
      youtubeUrl: 'https://youtube.com/channel/UC-finance-adjacent',
      description: '',
      videoTitles: [],
      admissionDecisionId: 'decision-finance-adjacent',
      admissionStatus: 'ADMITTED',
      admissionDecisionSource: 'SEMANTIC',
      admissionConfirmedTrading: true,
      admissionTradingConfidence: 88,
      admissionProvider: 'gemini_semantic',
      admissionCitations: [
        { field: 'bio', quote: 'personal finance and investing', supports: 'FINANCE_ADJACENT' },
      ],
    },
  );
  assert.equal(built.decision.positiveEvidence[0]?.provenance?.semantic?.taxonomyLabel, 'FINANCE_ADJACENT');
  assert.equal(hasAiLedTradingConfirmation(built.decision.positiveEvidence), false);
});

test('admission evidence with a real provider exposes the AI-led trading label', () => {
  const built = buildAdmissionConfirmedClassification(
    { channel_name: 'Provider Trader', description: '', country: 'Unknown' },
    {
      channelId: 'UC-provider-trader',
      channelName: 'Provider Trader',
      youtubeUrl: 'https://youtube.com/channel/UC-provider-trader',
      description: '',
      videoTitles: [],
      admissionDecisionId: 'decision-provider-trader',
      admissionStatus: 'ADMITTED',
      admissionDecisionSource: 'SEMANTIC',
      admissionConfirmedTrading: true,
      admissionTradingConfidence: 88,
      admissionProvider: 'gemini_semantic',
      admissionCitations: [
        { field: 'bio', quote: 'price action and risk management', supports: 'TRADING' },
      ],
    },
  );
  assert.equal(built.decision.positiveEvidence[0]?.provenance?.semantic?.taxonomyLabel, 'ACTIVE_TRADING');
  assert.equal(hasAiLedTradingConfirmation(built.decision.positiveEvidence), true);
});

test('legacy probability normalization does not fire without a usable trading citation', () => {
  const built = buildAdmissionConfirmedClassification(
    { channel_name: 'Title Only Legacy', description: '', country: 'Unknown' },
    {
      channelId: 'UC-legacy-title-only',
      channelName: 'Title Only Legacy',
      youtubeUrl: 'https://youtube.com/channel/UC-legacy-title-only',
      description: '',
      videoTitles: [],
      admissionDecisionId: 'decision-legacy-title-only',
      admissionStatus: 'ADMITTED',
      admissionDecisionSource: 'SEMANTIC',
      admissionConfirmedTrading: true,
      admissionTradingConfidence: 1,
      admissionCitations: [
        { field: 'channel_name', quote: 'Title Only Legacy', supports: 'TRADING' },
      ],
    },
  );
  assert.equal(built.result.status, 'UNCERTAIN');
  assert.equal(built.decision.confidenceScore, 1);
});

test('a genuinely low confirmed semantic admission remains reviewable', () => {
  const built = buildAdmissionConfirmedClassification(
    { channel_name: 'Low Focus Trader', description: '', country: 'Unknown' },
    {
      channelId: 'UC-low-focus',
      channelName: 'Low Focus Trader',
      youtubeUrl: 'https://youtube.com/channel/UC-low-focus',
      description: '',
      videoTitles: [],
      admissionDecisionId: 'decision-low-focus',
      admissionStatus: 'ADMITTED',
      admissionDecisionSource: 'SEMANTIC',
      admissionConfirmedTrading: true,
      admissionTradingConfidence: 5,
      admissionCitations: [
        { field: 'bio', quote: 'some trading content', supports: 'TRADING' },
      ],
    },
  );
  assert.equal(built.result.status, 'UNCERTAIN');
  assert.equal(built.decision.confidenceScore, 5);
  assert.equal(built.decision.deterministicRouting?.humanReview, true);
});

test('production-shaped semantic admission with bio citations survives missing provider', () => {
  const built = buildAdmissionConfirmedClassification(
    { channel_name: 'Da Stock Analyst', description: '', country: 'Unknown' },
    {
      channelId: 'UC-production-bio',
      channelName: 'Da Stock Analyst',
      youtubeUrl: 'https://youtube.com/channel/UC-production-bio',
      description: '',
      videoTitles: ['#STI breakout', '#STI next week'],
      admissionDecisionId: 'decision-production-bio',
      admissionStatus: 'ADMITTED',
      admissionDecisionSource: 'SEMANTIC',
      admissionConfirmedTrading: true,
      admissionTradingConfidence: 88,
      admissionModel: 'gemini-3.5-flash-lite',
      admissionCitations: [
        { field: 'bio', quote: 'stocks', supports: 'TRADING' },
        { field: 'bio', quote: 'trader', supports: 'TRADING' },
      ],
    },
  );
  assert.equal(built.result.status, 'TRADING_CONFIRMED');
  assert.equal(built.decision.deterministicRouting?.humanReview, false);
  assert.equal(built.decision.deterministicRouting?.route, 'SEMANTIC_TRADING');
  assert.equal(built.decision.evidenceCollection.providers[0]?.provider, 'admission_decision');
  assert.equal(built.decision.positiveEvidence.length, 2);
});

test('confirmed semantic admission without creator-owned citations stays reviewable', () => {
  const built = buildAdmissionConfirmedClassification(
    { channel_name: 'Legacy Trader', description: 'market analysis', country: 'France' },
    {
      channelId: 'UC-confirmed-legacy',
      channelName: 'Legacy Trader',
      youtubeUrl: 'https://youtube.com/channel/UC-confirmed-legacy',
      description: 'market analysis',
      videoTitles: [],
      admissionDecisionId: 'decision-semantic-2',
      admissionStatus: 'ADMITTED',
      admissionDecisionSource: 'SEMANTIC',
      admissionConfirmedTrading: true,
      admissionTradingConfidence: 91,
      admissionCitations: [],
    },
  );
  assert.equal(built.result.status, 'UNCERTAIN');
  assert.equal(built.decision.status, 'UNCERTAIN');
  assert.equal(built.decision.evidenceCollection.sufficiency, 'INSUFFICIENT');
  assert.equal(built.decision.deterministicRouting?.humanReview, true);
  assert.match(built.decision.evidenceCollection.reasonCodes.join(','), /SEMANTIC_ADMISSION_CITATIONS_MISSING/);
});

test('confirmed semantic admission with only title citations stays reviewable', () => {
  const built = buildAdmissionConfirmedClassification(
    { channel_name: 'Title Only Trader', description: '', country: 'Unknown' },
    {
      channelId: 'UC-confirmed-title',
      channelName: 'Title Only Trader',
      youtubeUrl: 'https://youtube.com/channel/UC-confirmed-title',
      description: '',
      videoTitles: [],
      admissionDecisionId: 'decision-semantic-title',
      admissionStatus: 'ADMITTED',
      admissionDecisionSource: 'SEMANTIC',
      admissionConfirmedTrading: true,
      admissionTradingConfidence: 91,
      admissionCitations: [
        { field: 'channel_name', quote: 'Title Only Trader', supports: 'TRADING' },
      ],
    },
  );
  assert.equal(built.result.status, 'UNCERTAIN');
  assert.equal(built.decision.deterministicRouting?.humanReview, true);
  assert.match(built.decision.deterministicRouting?.fallbackReason || '', /TITLE_ONLY/);
  // The production handoff emits `channel_name`, not `channel_title`; both
  // title forms must remain review-only.
  const legacyTitle = buildAdmissionConfirmedClassification(
    { channel_name: 'Legacy Title Trader', description: '', country: 'Unknown' },
    {
      channelId: 'UC-confirmed-title-legacy',
      channelName: 'Legacy Title Trader',
      youtubeUrl: 'https://youtube.com/channel/UC-confirmed-title-legacy',
      description: '',
      videoTitles: [],
      admissionDecisionId: 'decision-semantic-title-legacy',
      admissionStatus: 'ADMITTED',
      admissionDecisionSource: 'SEMANTIC',
      admissionConfirmedTrading: true,
      admissionTradingConfidence: 91,
      admissionCitations: [
        { field: 'channel_title', quote: 'Legacy Title Trader', supports: 'TRADING' },
      ],
    },
  );
  assert.equal(legacyTitle.result.status, 'UNCERTAIN');
});

test('a low-confidence confirmed semantic admission still requires review', () => {
  const built = buildAdmissionConfirmedClassification(
    { channel_name: 'Weak Signal', description: 'price action and risk management', country: 'Unknown' },
    {
      channelId: 'UC-confirmed-low',
      channelName: 'Weak Signal',
      youtubeUrl: 'https://youtube.com/channel/UC-confirmed-low',
      description: 'price action and risk management',
      videoTitles: [],
      admissionDecisionId: 'decision-semantic-low',
      admissionStatus: 'ADMITTED',
      admissionDecisionSource: 'SEMANTIC',
      admissionConfirmedTrading: true,
      admissionTradingConfidence: 40,
      admissionCitations: [
        { field: 'channel_bio', quote: 'price action and risk management', supports: 'TRADING' },
      ],
    },
  );
  assert.equal(built.result.status, 'UNCERTAIN');
  assert.equal(built.decision.deterministicRouting?.humanReview, true);
  assert.equal(built.decision.evidenceCollection.sufficiency, 'SUFFICIENT');
});

test('admission dedupe and admitted preservation prevent duplicate classification/enrichment', () => {
  const admit = functionSource(queue, 'admitDiscoveredChannel');
  const shared = functionSource(queue, 'processDiscoveredChannel');
  assert.match(admit, /hasActiveAdmissionJob/);
  assert.match(shared, /hasActiveAdmissionJob/);
  assert.match(admit, /shouldPreserveExistingChannel/);
  assert.match(admit, /hasActiveEnrichmentJob/);
  assert.match(admit, /shouldReclassifyPreservedCompletedChannel/);
  assert.ok(admit.indexOf('hasActiveAdmissionJob') < admit.indexOf('enqueueAdmissionVerification'),
    'active admission job must be checked before any enqueue');
  assert.ok(shared.indexOf('hasActiveAdmissionJob') < shared.indexOf('enqueueAdmissionVerification'),
    'shared discovery path must check the active job before enqueue');
  const worker = readFileSync(new URL('./worker.ts', import.meta.url), 'utf8');
  assert.match(worker, /nextAdmissionVerificationAttempt/);
  assert.match(worker, /resumeAdmittedCandidate/);
  const index = readFileSync(new URL('./index.ts', import.meta.url), 'utf8');
  assert.match(index, /export async function resolveAdmissionReview/);
  const reviewScript = readFileSync(new URL('../../scripts/reviewAdmissionCandidates.ts', import.meta.url), 'utf8');
  assert.match(reviewScript, /resolveAdmissionReview/);
  const verify = functionSource(index, 'verifyAdmissionCandidate');
  assert.ok(verify.indexOf('options.archiveRejectedExistingChannel') > -1
    && verify.indexOf('options.archiveRejectedExistingChannel') < verify.lastIndexOf('recordAdmissionOutcome'),
  'rejection side effects must complete before the terminal decision commit');
  assert.ok(worker.indexOf('if (isRejectedAdmissionStatus(row.status))') > -1
    && worker.indexOf('if (isRejectedAdmissionStatus(row.status))') < worker.indexOf('verifyAdmissionCandidate(input'),
  'review/rejected rows must not re-enter verification');
  assert.match(verify, /classificationCandidateForAdmission\(input\.candidate, \{ \.\.\.row, evidence_snapshot: evidence \}\)/);
  assert.match(verify, /NO_CREATOR_CONTENT_CONTEXT/);
  assert.match(verify, /PRE_CATALOG_CLASSIFICATION_UNCERTAIN/);
  assert.match(verify, /classifyTradingRelevanceDetailed/);
  assert.doesNotMatch(verify, /ProviderAdmissionJudge|judge\.judge\(evidence/);
  assert.doesNotMatch(verify, /decision: 'ADMIT_AMBIGUOUS'/);
  assert.match(verify, /EVIDENCE_ACQUISITION_REQUIRED/);

  assert.match(index, /admissionStatus === 'ADMITTED_AMBIGUOUS' && decisionSource === 'DETERMINISTIC'/);
});

test('classification stage reflects the admission handoff without claiming hydration', () => {
  assert.equal(classificationStageForCandidate({ admissionClassified: true, enrichmentStage: 0 }), 1);
  assert.equal(classificationStageForCandidate({ admissionClassified: true, enrichmentStage: 2 }), 2);
  assert.equal(classificationStageForCandidate({ admissionClassified: false, enrichmentStage: 0 }), 0);
  assert.equal(classificationStageForCandidate({ admissionClassified: false, enrichmentStage: 1 }), 1);
  assert.equal(classificationStageForCandidate({ admissionClassified: false }), 0);
});

test('admission classification marks the handoff without mutating hydration state', () => {
  const start = index.indexOf('async function enqueueClassificationAfterAdmission(');
  assert.ok(start >= 0, 'classification handoff must exist');
  const end = index.indexOf('\nexport ', start + 10);
  const enqueue = index.slice(start, end < 0 ? undefined : end);
  assert.match(enqueue, /admissionClassified: true/);
  assert.doesNotMatch(enqueue, /enrichmentStage: Math\.max\(1, Number\(input\.candidate\.enrichmentStage \|\| 0\)\)/);
  assert.doesNotMatch(enqueue, /UPDATE jobs/);
  assert.match(pipeline, /enrichment_stage:classificationStageForCandidate\(candidate\)/);
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
  assert.match(queue, /const admissionSemanticClaimable = admissionModeActive;/);
  assert.doesNotMatch(queue, /admissionSemanticRouteHealthy/);
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

test('pre-catalog semantic decisions are reused by the post-catalog handoff', () => {
  const base = { admissionConfirmedTrading: true, admissionDecisionId: 'decision-1', admissionDecisionSource: 'SEMANTIC' as const };
  assert.equal(admissionShortcutEligible({ ...base, admissionClassified: false }, 'ACTIVE'), false);
  assert.equal(admissionShortcutEligible({ ...base, admissionClassified: true }, 'ACTIVE'), true);
});

test('semantic provider outages become provider-deferred instead of missing evidence', () => {
  const base = { evidenceCollection: { providers: [{ provider: 'gemini_semantic', availability: 'FAILED', outcome: 'FAILED_TIMEOUT' }] }, decisionPolicy: { reasonCodes: [] } } as any;
  assert.equal(isPreCatalogProviderDeferredDecision(base), true);
  assert.equal(isPreCatalogProviderDeferredDecision({
    ...base,
    evidenceCollection: { providers: [{ provider: 'gemini_semantic', availability: 'AVAILABLE', outcome: 'EXECUTED_WITH_EVIDENCE' }] },
  }), false);
  assert.equal(isPreCatalogProviderDeferredDecision({
    ...base,
    evidenceCollection: { providers: [] },
    decisionPolicy: { reasonCodes: ['PRECISION_ADJUDICATOR_CAPACITY_DEFERRED'] },
  }), true);
  assert.equal(isPreCatalogProviderDeferredDecision({
    ...base,
    evidenceCollection: { providers: [{ provider: 'gemini_semantic', availability: 'UNAVAILABLE', outcome: 'UNAVAILABLE_CONFIGURATION' }] },
  }), true);
});

test('snapshot-only audits preserve attempts and never expire', () => {
  assert.equal(nextAdmissionEvidenceAttempt(2, true), 2);
  assert.equal(nextAdmissionEvidenceAttempt(2, false), 3);
  assert.equal(admissionEvidenceExpired(3, true, null), false);
  assert.equal(admissionEvidenceExpired(3, false, null), true);
  assert.equal(admissionEvidenceExpired(1, false, '2000-01-01T00:00:00.000Z'), true);
});
