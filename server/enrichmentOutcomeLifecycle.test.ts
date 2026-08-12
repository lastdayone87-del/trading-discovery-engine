import assert from 'node:assert/strict';
import test from 'node:test';
import { evaluateClassificationStages } from './evidenceEngine/stagedClassification';
import { hasIndependentTradingHypothesis } from './candidateTriage';
import { planEvidenceAction } from './voiEvidenceController';

test('repeated independent trading-focused uploads establish candidate and corroboration gates', () => {
  const evidence = [{
    id: 'multi-video', source: 'video_metadata', polarity: 'POSITIVE', category: 'MULTI_VIDEO_CONSISTENCY',
    fact: '7/10 recent videos are trading focused', rawMatches: ['Live Trading 1','Live Trading 2','Live Trading 3'],
    confidence: 70, reliability: 'VERY_HIGH', reliabilityMultiplier: 1, rawWeight: 21, finalWeight: 21,
    provenance: { provider: 'video_metadata', type: 'MULTI_VIDEO_CONSISTENCY', matchedTerm: '7/10', sourceRef: 'recent uploads', fields: [
      { field: 'video_title', index: 0, sourceId: 'v1', sourceFamilyId: 'family-v1', sourceEntityId: 'channel-1' },
      { field: 'video_title', index: 1, sourceId: 'v2', sourceFamilyId: 'family-v2', sourceEntityId: 'channel-1' },
      { field: 'video_title', index: 2, sourceId: 'v3', sourceFamilyId: 'family-v3', sourceEntityId: 'channel-1' }
    ]}, timestamp: new Date().toISOString()
  }] as any;
  const collection = { sufficiency: 'SUFFICIENT', sparseMetadata: false, degraded: false, fieldsPresent: ['video_titles'], reasonCodes: [], providers: [], terminalNegativeSufficiency: { status: 'INSUFFICIENT', creatorLevelCoverage: false, independentSourceFamilies: 0, independentObservations: 0, reasonCodes: [] } } as any;
  const stages = evaluateClassificationStages({ channel_name: 'Creator', description: '', enrichment_stage: 1 } as any, evidence, collection);
  assert.equal(stages.stages.find(stage => stage.stage === 'CANDIDATE_DETECTION')?.disposition, 'PASS');
  assert.equal(stages.stages.find(stage => stage.stage === 'CORROBORATION')?.disposition, 'PASS');
  assert.equal(stages.lifecycleAction, 'CONFIRM');
});

test('degraded evidence never becomes no-hypothesis withholding', () => {
  const decision = {
    status: 'UNCERTAIN', positiveEvidence: [], negativeEvidence: [],
    evidenceCollection: { degraded: true }, stagedClassification: { stages: [] }
  } as any;
  assert.equal(hasIndependentTradingHypothesis(decision), true);
});

test('stage two provider degradation gets one bounded stage three retry before human review', () => {
  const decision = {
    status: 'UNCERTAIN', timestamp: new Date().toISOString(), positiveEvidence: [], negativeEvidence: [],
    evidenceCollection: { sufficiency: 'SUFFICIENT', sparseMetadata: false, degraded: true, fieldsPresent: ['video_titles'], reasonCodes: ['PROVIDER_COVERAGE_DEGRADED'], providers: [{ provider: 'gemini_semantic', availability: 'FAILED', outcome: 'FAILED_PROVIDER', reasonCodes: ['PROVIDER_TRANSIENT_FAILURE'] }] },
    stagedClassification: { stages: [
      { stage: 'CANDIDATE_DETECTION', disposition: 'ABSTAIN' },
      { stage: 'CORROBORATION', disposition: 'ABSTAIN' }
    ] }
  } as any;
  const plan = planEvidenceAction({ decision, rawInput: { channel_name: 'Creator', description: '', enrichment_stage: 2 } as any, mode: 'OFF', providerQuotaRemaining: 1000 });
  assert.equal(plan.legacyAction, 'PROVIDER_RETRY');
  assert.equal(plan.appliedAction, 'PROVIDER_RETRY');
  assert.equal(plan.gaps.includes('PROVIDER_DEGRADED'), true);
});

test('successful fully enriched ambiguity still routes to human review', () => {
  const decision = {
    status: 'UNCERTAIN', timestamp: new Date().toISOString(), positiveEvidence: [], negativeEvidence: [],
    evidenceCollection: { sufficiency: 'SUFFICIENT', sparseMetadata: false, degraded: false, fieldsPresent: ['video_titles'], reasonCodes: [], providers: [] },
    stagedClassification: { stages: [
      { stage: 'CANDIDATE_DETECTION', disposition: 'PASS' },
      { stage: 'CORROBORATION', disposition: 'ABSTAIN' }
    ] }
  } as any;
  const plan = planEvidenceAction({ decision, rawInput: { channel_name: 'Creator', description: '', enrichment_stage: 2 } as any, mode: 'OFF', providerQuotaRemaining: 1000 });
  assert.equal(plan.legacyAction, 'HUMAN_REVIEW');
  assert.equal(plan.appliedAction, 'HUMAN_REVIEW');
});
