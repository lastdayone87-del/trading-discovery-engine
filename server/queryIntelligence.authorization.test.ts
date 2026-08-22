import assert from 'node:assert/strict';
import test from 'node:test';
import {
  classifyCountryNativeAuthorizationInput,
  type QueryIntelligenceAuthorizationInputResult
} from './queryIntelligence';
import { createNeighborhoodKey } from './discoveryNeighborhood';

const dimensions = (country: string, language: string) => ({
  country,
  language,
  queryIntent: 'strategy',
  primaryTermFamily: 'market structure',
  retrievalLane: 'YOUTUBE_NATIVE',
  searchOrdering: 'RELEVANCE',
  instrumentOrTheme: null,
  sourceFamily: 'country_native'
} as const);

const input = (overrides: Record<string, unknown> = {}) => {
  const target = dimensions('France', 'fr');
  return {
    country: 'France',
    decisionId: 'decision-stage3',
    proposalId: 'proposal-stage3',
    targetNeighborhoodDimensions: target,
    proposalEvidenceSnapshot: {
      proposalFamily: 'COUNTRY_NATIVE',
      targetNeighborhoodKey: createNeighborhoodKey(target),
      targetDimensions: target,
      supportingEvidence: { nativeTerm: 'structure de marché', evidenceChecksum: 'checksum-stage3' },
      ...overrides
    }
  };
};

function codeOf(result: QueryIntelligenceAuthorizationInputResult): string {
  assert.equal(result.status, 'REJECTED');
  return result.code;
}

test('Stage 3 accepts valid immutable proposal input for persistent and future supported countries', () => {
  const france = classifyCountryNativeAuthorizationInput(input());
  assert.equal(france.status, 'VALID');
  if (france.status === 'VALID') assert.equal(france.targetKey, createNeighborhoodKey(dimensions('France', 'fr')));

  const japanTarget = dimensions('Japan', 'ja');
  const japan = classifyCountryNativeAuthorizationInput({
    ...input(),
    country: 'Japan',
    targetNeighborhoodDimensions: japanTarget,
    proposalEvidenceSnapshot: {
      proposalFamily: 'COUNTRY_NATIVE',
      targetNeighborhoodKey: createNeighborhoodKey(japanTarget),
      targetDimensions: japanTarget,
      supportingEvidence: { nativeTerm: '相場分析', evidenceChecksum: 'checksum-japan' }
    }
  });
  assert.equal(japan.status, 'VALID');
});

test('Stage 3 classifies unsupported proposal family as expected governance rejection', () => {
  assert.equal(codeOf(classifyCountryNativeAuthorizationInput(input({ proposalFamily: 'UNRELATED' }))), 'PROPOSAL_FAMILY_UNSUPPORTED');
});

test('Stage 3 classifies target-neighborhood and target-dimensions mismatches', () => {
  const target = dimensions('France', 'fr');
  assert.equal(codeOf(classifyCountryNativeAuthorizationInput(input({ targetNeighborhoodKey: 'wrong-key' }))), 'TARGET_NEIGHBORHOOD_MISMATCH');
  assert.equal(codeOf(classifyCountryNativeAuthorizationInput(input({ targetDimensions: dimensions('Germany', 'de') }))), 'TARGET_NEIGHBORHOOD_MISMATCH');
  assert.equal(createNeighborhoodKey(target), createNeighborhoodKey(dimensions('France', 'fr')));
});

test('Stage 3 classifies missing native terms and missing evidence checksums', () => {
  assert.equal(codeOf(classifyCountryNativeAuthorizationInput(input({ supportingEvidence: { evidenceChecksum: 'present' } }))), 'NATIVE_TERM_MISSING');
  assert.equal(codeOf(classifyCountryNativeAuthorizationInput(input({ supportingEvidence: { nativeTerm: 'structure de marché' } }))), 'EVIDENCE_CHECKSUM_MISSING');
});

test('Stage 3 classifies over-specific native terms before planner authorization', () => {
  assert.equal(codeOf(classifyCountryNativeAuthorizationInput(input({
    supportingEvidence: { nativeTerm: 'one two three four', evidenceChecksum: 'checksum-stage3' }
  }))), 'QUERY_SPECIFICITY_REJECTED');
});
