import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateClassificationStages, isThinRetrievalInputRequiringHydration } from './stagedClassification';
import { evaluateUnifiedDecisionPolicy } from './decisionPolicy';
import { calibrateSemanticConfidence } from './semanticCalibration';
import type { EvidenceCollectionReport, EvidenceItem } from './types';

function semanticUnrelated(): EvidenceItem {
  const calibratedConfidence = calibrateSemanticConfidence(96);
  const rawWeight = 26;
  return {
    id: 'semantic-unrelated',
    source: 'gemini_semantic',
    polarity: 'NEGATIVE',
    category: 'IRRELEVANT_DOMAIN',
    fact: 'Multilingual semantic evidence [UNRELATED]: generic boilerplate with no financial content.',
    rawMatches: ['boilerplate'],
    confidence: calibratedConfidence,
    reliability: 'MEDIUM',
    reliabilityMultiplier: 0.65,
    rawWeight,
    finalWeight: -(rawWeight * 0.65 * (calibratedConfidence / 100)),
    timestamp: new Date(0).toISOString(),
    provenance: {
      provider: 'gemini_semantic',
      type: 'IRRELEVANT_DOMAIN',
      matchedTerm: 'boilerplate',
      sourceRef: 'structured-semantic:gemini-3.6-flash',
      fields: [{ field: 'channel_bio', sourceId: 'about' }],
      semantic: {
        modelVersion: 'gemini-3.6-flash',
        promptVersion: 'priority2-multilingual-structured-1',
        featureVersion: 'field-aware-evidence-1',
        calibrationVersion: 'multilingual-semantic-calibration-bootstrap-1',
        taxonomyLabel: 'UNRELATED',
        rawConfidence: 96,
        calibratedConfidence,
        detectedLanguages: [],
        reasonCodes: ['NO_FINANCIAL_CONTENT']
      }
    }
  } as EvidenceItem;
}

function sufficientCollection(): EvidenceCollectionReport {
  return {
    sufficiency: 'SUFFICIENT',
    sparseMetadata: false,
    degraded: false,
    fieldsPresent: ['channel_name', 'description', 'external_links', 'activity_metadata'],
    reasonCodes: [],
    providers: [{ provider: 'gemini_semantic', availability: 'AVAILABLE', evidenceCount: 0, outcome: 'EXECUTED_WITH_EVIDENCE', reasonCodes: ['PROVIDER_EVIDENCE_EMITTED'] }],
    terminalNegativeSufficiency: {
      status: 'SUFFICIENT',
      creatorLevelCoverage: true,
      independentSourceFamilies: 1,
      independentObservations: 1,
      reasonCodes: ['CREATOR_LEVEL_NEGATIVE_COVERAGE']
    }
  };
}

const thinRetrievalInput = {
  channel_name: 'Harborlight Media',
  description: 'Share your videos with friends, family, and the world',
  video_titles: [] as string[],
  videos: [] as Array<{ title: string }>,
  enrichment_stage: 0,
  search_match_context: { type: 'VIDEO' as const, title: 'USD/CHF Price Forecast Today', locator: 'youtube:video:l7thcsSpOeQ' }
};

const hydratedInput = {
  ...thinRetrievalInput,
  enrichment_stage: 1,
  video_titles: ['USD/CHF Price Forecast Today', 'EUR/USD Weekly Outlook'],
  videos: [{ title: 'USD/CHF Price Forecast Today' }]
};

function decide(input: any, evidence: EvidenceItem[], collection = sufficientCollection()) {
  const stages = evaluateClassificationStages(input, evidence, collection);
  return {
    stages,
    decision: evaluateUnifiedDecisionPolicy({
      evidence,
      collection,
      lifecycleAction: stages.lifecycleAction,
      minimumPositiveWeight: 25,
      minimumTradingScore: 68
    })
  };
}

test('thin retrieval input is detected as requiring hydration', () => {
  assert.equal(isThinRetrievalInputRequiringHydration(thinRetrievalInput), true);
  assert.equal(isThinRetrievalInputRequiringHydration(hydratedInput), false);
  assert.equal(isThinRetrievalInputRequiringHydration({ ...thinRetrievalInput, enrichment_stage: 1, search_match_context: undefined }), false);
  assert.equal(isThinRetrievalInputRequiringHydration({ channel_name: 'x', description: 'y' }), false);
});

test('single semantic UNRELATED on thin retrieval input routes to ENRICH, never terminal', () => {
  const { stages, decision } = decide(thinRetrievalInput, [semanticUnrelated()]);
  const contradiction = stages.stages.find(stage => stage.stage === 'CONTRADICTION');
  assert.equal(contradiction?.disposition, 'ABSTAIN');
  assert.ok(contradiction?.reasonCodes.includes('THIN_RETRIEVAL_INPUT_REQUIRES_HYDRATION'));
  assert.equal(stages.lifecycleAction, 'ENRICH');
  assert.equal(decision.status, 'UNCERTAIN');
});

test('same evidence on hydrated input still terminally rejects', () => {
  const { stages, decision } = decide(hydratedInput, [semanticUnrelated()]);
  assert.equal(stages.lifecycleAction, 'REJECT');
  assert.equal(decision.status, 'NON_TRADING');
});

test('withheld match titles are never fed into evidence by the guard', () => {
  const { stages } = decide(thinRetrievalInput, [semanticUnrelated()]);
  const usedFields = stages.stages.flatMap(stage => stage.fields?.map(field => field.field) || []);
  assert.ok(!usedFields.includes('video_title'));
});
