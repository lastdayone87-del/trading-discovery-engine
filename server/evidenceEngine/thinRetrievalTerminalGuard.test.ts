import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateClassificationStages, isThinRetrievalInputRequiringHydration } from './stagedClassification';
import { evaluateUnifiedDecisionPolicy } from './decisionPolicy';
import { calibrateSemanticConfidence } from './semanticCalibration';
import { buildContextualComposition } from './contextualComposition';
import { buildCanonicalEvidenceCorpus } from './canonicalEvidencePlane';
import type { ContextualCompositionReport } from './contextualComposition';
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

function decide(input: any, evidence: EvidenceItem[], collection = sufficientCollection(), composition?: ContextualCompositionReport) {
  const stages = evaluateClassificationStages(input, evidence, collection, composition);
  return {
    stages,
    decision: evaluateUnifiedDecisionPolicy({
      evidence,
      collection,
      lifecycleAction: stages.lifecycleAction,
      minimumPositiveWeight: 25,
      minimumTradingScore: 68,
      composition
    })
  };
}

test('thin retrieval input is detected as requiring hydration', () => {
  assert.equal(isThinRetrievalInputRequiringHydration(thinRetrievalInput), true);
  assert.equal(isThinRetrievalInputRequiringHydration(hydratedInput), false);
  // Each guard independently disables the thin classification: dropping only
  // the stage signal or only the provenance signal must suffice.
  assert.equal(isThinRetrievalInputRequiringHydration({ ...thinRetrievalInput, enrichment_stage: 1 }), false);
  assert.equal(isThinRetrievalInputRequiringHydration({ ...thinRetrievalInput, search_match_context: undefined }), false);
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
  // The fixture carries a trading-relevant VIDEO match title that the
  // anti-contamination layer withholds from evidence; the guard must route
  // to ENRICH on the thin input rather than terminally rejecting, and no
  // video_title field may appear among the staged evidence fields.
  const { stages, decision } = decide(thinRetrievalInput, [semanticUnrelated()]);
  assert.equal(decision.status, 'UNCERTAIN');
  const usedFields = stages.stages.flatMap(stage => stage.fields?.map(field => field.field) || []);
  assert.ok(!usedFields.includes('video_title'));
});

test('descriptions-only input counts as hydrated only when authoritative', () => {
  const descriptionsOnly = {
    ...thinRetrievalInput,
    video_descriptions: ['Weekly forex outlook and price action review']
  };
  // Retrieval-derived descriptions without the enrichment hydration marker
  // are not hydration evidence: still thin.
  assert.equal(isThinRetrievalInputRequiringHydration(descriptionsOnly), true);
  const { stages } = decide(descriptionsOnly, [semanticUnrelated()]);
  assert.equal(stages.lifecycleAction, 'ENRICH');
  // The same sample marked authoritative (set only by enrichment hydration)
  // disables the thin classification and preserves terminal routing.
  assert.equal(
    isThinRetrievalInputRequiringHydration({ ...descriptionsOnly, videoDescriptionsAuthoritative: true }),
    false
  );
});

function positiveItem(id: string, category: string, field: string, family: string, weight: number): EvidenceItem {
  return {
    id,
    source: 'gemini_semantic',
    polarity: 'POSITIVE',
    category,
    fact: `trading evidence ${id}`,
    rawMatches: ['forex'],
    confidence: 80,
    reliability: 'MEDIUM',
    reliabilityMultiplier: 1,
    rawWeight: weight,
    finalWeight: weight,
    timestamp: new Date(0).toISOString(),
    provenance: {
      provider: 'gemini_semantic',
      type: category,
      matchedTerm: 'forex',
      sourceRef: 'structured-semantic:gemini-3.6-flash',
      fields: [{ field, sourceId: id, sourceFamilyId: family }]
    }
  } as EvidenceItem;
}

test('thin input with affirmative positives keeps REVIEW (never forced to ENRICH)', () => {
  const evidence = [
    positiveItem('pos-1', 'TERMINOLOGY', 'channel_bio', 'fam-bio', 20),
    positiveItem('pos-2', 'INSTRUMENT', 'external_link_domain', 'fam-link', 18),
    {
      id: 'hype-negative',
      source: 'channel_metadata',
      polarity: 'NEGATIVE',
      category: 'HYPE_SPECULATION',
      fact: 'promotional language without domain evidence',
      rawMatches: [],
      confidence: 70,
      reliability: 'MEDIUM',
      reliabilityMultiplier: 1,
      rawWeight: 30,
      finalWeight: -30,
      timestamp: new Date(0).toISOString(),
      provenance: {
        provider: 'channel_metadata',
        type: 'HYPE_SPECULATION',
        matchedTerm: 'moon',
        sourceRef: 'deterministic:channel_metadata',
        fields: [{ field: 'channel_bio', sourceId: 'about' }]
      }
    } as EvidenceItem
  ];
  const { stages, decision } = decide(thinRetrievalInput, evidence);
  const candidate = stages.stages.find(stage => stage.stage === 'CANDIDATE_DETECTION');
  const corroboration = stages.stages.find(stage => stage.stage === 'CORROBORATION');
  assert.equal(candidate?.disposition, 'PASS');
  assert.equal(corroboration?.disposition, 'PASS');
  assert.equal(stages.lifecycleAction, 'REVIEW');
  assert.equal(decision.status, 'UNCERTAIN');
});

function retrievalOnlyInput() {
  const input: any = {
    channel_name: 'Harborlight Media',
    description: '',
    video_titles: [] as string[],
    videos: [] as Array<{ title: string }>,
    enrichment_stage: 0,
    search_match_context: { type: 'VIDEO' as const, title: 'USD/CHF Price Forecast Today', locator: 'youtube:video:l7thcsSpOeQ' }
  };
  input.evidence_corpus = buildCanonicalEvidenceCorpus(input);
  return input;
}

function affirmativeEvidence(): EvidenceItem[] {
  return [
    positiveItem('pos-1', 'TERMINOLOGY', 'channel_bio', 'fam-bio', 20),
    positiveItem('pos-2', 'INSTRUMENT', 'external_link_domain', 'fam-link', 18)
  ];
}

function mixedNegative(): EvidenceItem {
  return {
    id: 'hype-negative',
    source: 'channel_metadata',
    polarity: 'NEGATIVE',
    category: 'HYPE_SPECULATION',
    fact: 'promotional language without domain evidence',
    rawMatches: [],
    confidence: 70,
    reliability: 'MEDIUM',
    reliabilityMultiplier: 1,
    rawWeight: 30,
    finalWeight: -30,
    timestamp: new Date(0).toISOString(),
    provenance: {
      provider: 'channel_metadata',
      type: 'HYPE_SPECULATION',
      matchedTerm: 'moon',
      sourceRef: 'deterministic:channel_metadata',
      fields: [{ field: 'channel_bio', sourceId: 'about' }]
    }
  } as EvidenceItem;
}

test('query-only composition preserves affirmative REVIEW and never confirms', () => {
  const input = retrievalOnlyInput();
  const composition = buildContextualComposition(input);
  assert.equal(composition.focus, 'QUERY_ONLY');

  // Candidate and corroboration both pass with no contradiction: base routing
  // would CONFIRM, but a retrieval-only composition must stop at REVIEW.
  const { stages, decision } = decide(input, affirmativeEvidence(), sufficientCollection(), composition);
  assert.equal(stages.stages.find(stage => stage.stage === 'CANDIDATE_DETECTION')?.disposition, 'PASS');
  assert.equal(stages.stages.find(stage => stage.stage === 'CORROBORATION')?.disposition, 'PASS');
  assert.equal(stages.lifecycleAction, 'REVIEW');
  assert.equal(decision.status, 'UNCERTAIN');

  // The mixed-evidence route is now penalty-only: hype no longer withholds
  // confirmation, so the contradiction stage passes. Query-only routing still
  // preserves REVIEW instead of confirming.
  const abstained = decide(input, [...affirmativeEvidence(), mixedNegative()], sufficientCollection(), composition);
  assert.equal(abstained.stages.stages.find(stage => stage.stage === 'CONTRADICTION')?.disposition, 'PASS');
  assert.equal(abstained.stages.lifecycleAction, 'REVIEW');
  assert.equal(abstained.decision.status, 'UNCERTAIN');
});

test('policy-level confirmation gate rejects a query-only composition', () => {
  const input = retrievalOnlyInput();
  const composition = buildContextualComposition(input);
  assert.equal(composition.focus, 'QUERY_ONLY');
  const decision = evaluateUnifiedDecisionPolicy({
    evidence: affirmativeEvidence(),
    collection: sufficientCollection(),
    lifecycleAction: 'CONFIRM',
    minimumPositiveWeight: 25,
    minimumTradingScore: 68,
    composition
  });
  assert.equal(decision.status, 'UNCERTAIN');
  assert.ok(decision.reasonCodes.includes('CONTEXTUAL_COMPOSITION_CONFIRMATION_REQUIRED'));
});

test('insufficient coverage preserves affirmative REVIEW and a supported terminal REJECT', () => {
  // An authoritative creator bio is present, so a terminal creator-level
  // rejection is supportable even though the overall composition is still
  // thin. An empty description would rely on the mocked collection alone.
  const input = {
    ...retrievalOnlyInput(),
    description: 'Independent media channel covering general interest topics and community news.',
    search_match_context: undefined,
  };
  input.evidence_corpus = buildCanonicalEvidenceCorpus(input);
  const composition = buildContextualComposition(input);
  assert.equal(composition.focus, 'INSUFFICIENT_COVERAGE');

  const affirmative = decide(input, affirmativeEvidence(), sufficientCollection(), composition);
  assert.equal(affirmative.stages.lifecycleAction, 'REVIEW');
  assert.equal(affirmative.decision.status, 'UNCERTAIN');

  const terminalNegative = decide(input, [semanticUnrelated()], sufficientCollection(), composition);
  assert.equal(terminalNegative.stages.stages.find(stage => stage.stage === 'CONTRADICTION')?.disposition, 'FAIL');
  assert.equal(terminalNegative.stages.lifecycleAction, 'REJECT');
  assert.equal(terminalNegative.decision.status, 'NON_TRADING');

  const noAffirmative = decide(input, [], sufficientCollection(), composition);
  assert.equal(noAffirmative.stages.lifecycleAction, 'ENRICH');
});

const strongCreatorComposition = {
  version: 'contextual-composition-v2',
  focus: 'TRADING_DOMINANT',
  observedFamilies: 2,
  informativeFamilies: 2,
  duplicateFamiliesCollapsed: 0,
  tradingFamilies: 2,
  tradingCoreFamilies: 2,
  tradingAdjacentFamilies: 0,
  financeAdjacentFamilies: 0,
  unrelatedFamilies: 0,
  uninformativeFamilies: 0,
  alternativeFamilies: 0,
  neutralFamilies: 0,
  recentTradingFamilies: 1,
  recentAlternativeFamilies: 0,
  tradingCoverage: 1,
  alternativeCoverage: 0,
  financeCoverage: 0,
  unrelatedCoverage: 0,
  temporalCoverage: 'KNOWN',
  nonTitleTierAFamilies: 2,
  explicitCreatorTrading: true,
  explicitCreatorAlternative: false,
  namePriorTrading: false,
  familyClassifications: [{ sourceFamilyId: 'fam-bio', field: 'channel_bio', focus: 'TRADING_CORE', recent: true, tierA: true, duplicateGroupId: null, signals: [], suppressedSignals: [] }],
  reasonCodes: ['EXPLICIT_CREATOR_TRADING_STATEMENT'],
} as ContextualCompositionReport;

const richCreatorBioInput = {
  ...thinRetrievalInput,
  description: 'Professional forex and futures trader sharing live market analysis, technical analysis, price action, trade setups and risk management education for active traders.',
};

test('strong creator-owned composition confirms even when a retrieval-only input lacks hydrated videos', () => {
  const evidence = [
    positiveItem('pos-bio', 'PLATFORM_BROKER_PROPFIRM', 'channel_bio', 'fam-bio', 24),
    positiveItem('pos-link', 'EXTERNAL_RESOURCE', 'external_link_domain', 'fam-link', 18),
  ];
  const { stages, decision } = decide(richCreatorBioInput, evidence, sufficientCollection(), strongCreatorComposition);
  assert.equal(stages.lifecycleAction, 'CONFIRM');
  assert.equal(decision.status, 'TRADING_CONFIRMED');
});

test('a short keyword bio is not enough for the thin-retrieval exception', () => {
  const evidence = [
    positiveItem('pos-bio', 'PLATFORM_BROKER_PROPFIRM', 'channel_bio', 'fam-bio', 24),
    positiveItem('pos-link', 'EXTERNAL_RESOURCE', 'external_link_domain', 'fam-link', 18),
  ];
  const { stages } = decide(thinRetrievalInput, evidence, sufficientCollection(), strongCreatorComposition);
  assert.equal(stages.lifecycleAction, 'REVIEW');
});

test('LEGACY restores the thin-retrieval review guard', () => {
  const previous = process.env.DETERMINISTIC_CLASSIFICATION_ROUTING;
  process.env.DETERMINISTIC_CLASSIFICATION_ROUTING = 'LEGACY';
  try {
    const evidence = [
      positiveItem('pos-bio', 'PLATFORM_BROKER_PROPFIRM', 'channel_bio', 'fam-bio', 24),
      positiveItem('pos-link', 'EXTERNAL_RESOURCE', 'external_link_domain', 'fam-link', 18),
    ];
    const { stages } = decide(richCreatorBioInput, evidence, sufficientCollection(), strongCreatorComposition);
    assert.equal(stages.lifecycleAction, 'REVIEW');
  } finally {
    if (previous === undefined) delete process.env.DETERMINISTIC_CLASSIFICATION_ROUTING;
    else process.env.DETERMINISTIC_CLASSIFICATION_ROUTING = previous;
  }
});

test('thin retrieval input without a strong creator-owned composition still routes to review', () => {
  const evidence = [
    positiveItem('pos-bio', 'TERMINOLOGY', 'channel_bio', 'fam-bio', 20),
    positiveItem('pos-link', 'INSTRUMENT', 'external_link_domain', 'fam-link', 18),
  ];
  const { stages } = decide(thinRetrievalInput, evidence, sufficientCollection());
  assert.equal(stages.lifecycleAction, 'REVIEW');
});
