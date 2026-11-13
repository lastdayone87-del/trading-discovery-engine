import assert from 'node:assert/strict';
import test from 'node:test';
import { INITIAL_COUNTRY_VOCABULARIES } from '../src/data/initial_countries';
import { admitQueryRecord } from './queryQuality/admission';
import { buildFrontierProposal } from './discoveryProposalGenerators';
import { planCountryNativeProposalQuery } from './queryPlanner';
import { classifyCountryNativeAuthorizationInput } from './queryIntelligence';
import { assessGeneratedNativeQuery, dedupeGeneratedCandidates } from './nativeQueryGeneration';

const france = INITIAL_COUNTRY_VOCABULARIES.find(item => item.country === 'France');
assert.ok(france);

const provenance = {
  source: 'LLM' as const,
  mode: 'OPEN_WORLD' as const,
  provider: 'groq',
  model: 'test-model',
  promptVersion: 'native-query-v1',
  batchId: 'batch-fr',
  country: 'France',
  language: 'fr',
  persona: null,
  scenario: null,
  prefix: null,
  generatedAt: '2026-11-13T00:00:00.000Z',
};

test('a genuine 4-6 word generated native phrase is admitted as a bounded standalone surface', () => {
  const planned = planCountryNativeProposalQuery({
    country: 'France',
    nativeTerm: 'analyse technique CAC 40',
    countryVocabulary: france,
    targetIntent: 'market_analysis',
    allocationLineage: { decisionId: 'decision-1', proposalId: 'proposal-1' },
    language: 'fr',
    generationSource: 'LLM_NATIVE_QUERY',
    generationProvenance: provenance,
  });
  assert.ok(planned, 'generated phrase should plan');
  assert.equal(planned.query, 'analyse technique CAC 40');
  assert.equal(planned.metadata.queryTemplate, 'LLM_NATIVE_PHRASE');
  assert.equal(planned.metadata.generatedNativePhrase, true);

  const admission = admitQueryRecord({
    query: planned.query,
    country: 'France',
    primary_term: planned.primaryTerm,
    generation_metadata: planned.metadata,
  });
  assert.equal(admission.eligible, true, admission.reasonCodes.join(', '));
  assert.notEqual(admission.admission.tier, 'SPECULATIVE');
});

test('native authorization accepts generated 4-6 word evidence but rejects >6 words', () => {
  const proposal = buildFrontierProposal({
    proposalFamily: 'COUNTRY_NATIVE',
    country: 'France',
    language: 'fr',
    concept: 'analyse technique CAC 40',
    intent: 'market_analysis',
    sourceProvenance: 'llm_native_query:test',
    supportingEvidence: {
      nativeTerm: 'analyse technique CAC 40',
      sourceProvenanceFamily: 'LLM_NATIVE_QUERY',
      language: 'fr',
      generationProvenance: provenance,
    },
    noveltyRationale: 'test',
  });
  const snapshot = {
    proposalFamily: 'COUNTRY_NATIVE',
    targetNeighborhoodKey: proposal.targetNeighborhoodKey,
    targetDimensions: proposal.targetDimensions,
    supportingEvidence: proposal.supportingEvidence,
  };
  assert.equal(classifyCountryNativeAuthorizationInput({
    country: 'France',
    decisionId: 'd1',
    proposalId: 'p1',
    targetNeighborhoodDimensions: proposal.targetDimensions,
    proposalEvidenceSnapshot: snapshot,
  }).status, 'VALID');

  const tooLong = buildFrontierProposal({
    proposalFamily: 'COUNTRY_NATIVE',
    country: 'France',
    language: 'fr',
    concept: 'analyse technique CAC 40 pour les débutants',
    intent: 'education',
    sourceProvenance: 'llm_native_query:test',
    supportingEvidence: {
      nativeTerm: 'analyse technique CAC 40 pour les débutants',
      sourceProvenanceFamily: 'LLM_NATIVE_QUERY',
      language: 'fr',
      generationProvenance: provenance,
    },
    noveltyRationale: 'test',
  });
  const tooLongResult = classifyCountryNativeAuthorizationInput({
    country: 'France',
    decisionId: 'd2',
    proposalId: 'p2',
    targetNeighborhoodDimensions: tooLong.targetDimensions,
    proposalEvidenceSnapshot: {
      proposalFamily: 'COUNTRY_NATIVE',
      targetNeighborhoodKey: tooLong.targetNeighborhoodKey,
      targetDimensions: tooLong.targetDimensions,
      supportingEvidence: tooLong.supportingEvidence,
    },
  });
  assert.equal(tooLongResult.status, 'REJECTED');
  if (tooLongResult.status === 'REJECTED') assert.equal(tooLongResult.code, 'QUERY_SPECIFICITY_REJECTED');
});

test('generated query validation rejects generic long and CTA surfaces', () => {
  assert.ok(assessGeneratedNativeQuery({
    query: 'analyse technique CAC 40',
    country: 'France',
    language: 'fr',
    source: 'LLM',
    mode: 'OPEN_WORLD',
    provider: 'groq',
    model: 'test',
    batchId: 'b1',
  }));
  assert.equal(assessGeneratedNativeQuery({
    query: 'analyse technique CAC 40 pour les débutants aujourd hui',
    country: 'France',
    language: 'fr',
    source: 'LLM',
    mode: 'OPEN_WORLD',
    provider: 'groq',
    model: 'test',
    batchId: 'b2',
  }), null);
  assert.equal(assessGeneratedNativeQuery({
    query: 'subscribe to my trading channel',
    country: 'France',
    language: 'fr',
    source: 'LLM',
    mode: 'OPEN_WORLD',
    provider: 'groq',
    model: 'test',
    batchId: 'b3',
  }), null);
});

test('generated batch dedupe removes repeats but keeps distinct intentions', () => {
  const result = dedupeGeneratedCandidates([
    { query: 'DAX Analyse heute', country: 'Germany', intent: 'market_analysis' },
    { query: 'DAX Analyse heute', country: 'Germany', intent: 'market_analysis' },
    { query: 'DAX live trading', country: 'Germany', intent: 'live_trading' },
  ]);
  assert.deepEqual(result.accepted.map(item => item.query), ['DAX Analyse heute', 'DAX live trading']);
  assert.equal(result.rejected.length, 1);
});
