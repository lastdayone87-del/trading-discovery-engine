import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildFrontierProposal,
  createProposalDedupKey,
  generateCountryNativeProposals
} from './discoveryProposalGenerators';

test('Phase 6: Proposal dedup key is deterministic and unique across dimensions', () => {
  const key1 = createProposalDedupKey('COUNTRY_NATIVE', 'JP', '日経平均', 'JP|ja|GENERAL|日経平均|ORGANIC|RELEVANCE|none|frontier_proposal');
  const key2 = createProposalDedupKey('COUNTRY_NATIVE', 'JP', '日経平均', 'JP|ja|GENERAL|日経平均|ORGANIC|RELEVANCE|none|frontier_proposal');
  const key3 = createProposalDedupKey('COUNTRY_NATIVE', 'JP', '日経平均 ', 'JP|ja|GENERAL|日経平均|ORGANIC|RELEVANCE|none|frontier_proposal');
  const keyDifferent = createProposalDedupKey('COUNTRY_NATIVE', 'US', '日経平均', 'US|ja|GENERAL|日経平均|ORGANIC|RELEVANCE|none|frontier_proposal');

  assert.equal(key1, key2, 'Identical proposals must yield exact same dedup key');
  assert.equal(key1, key3, 'Whitespace differences in concept must normalize to same dedup key');
  assert.notEqual(key1, keyDifferent, 'Different country must produce different dedup key');
});

test('Phase 6: Common proposal contract contains required fields and valid TTL', () => {
  const proposal = buildFrontierProposal({
    proposalFamily: 'COVERAGE_GAP',
    country: 'DE',
    concept: 'DAX hebelprodukte',
    sourceProvenance: 'health_diagnostic:INSTRUMENT:DAX',
    supportingEvidence: { underexploredQuotaPercent: 10 },
    confidence: 0.8,
    noveltyRationale: 'Identified coverage gap in DAX derivatives.'
  });

  assert.equal(proposal.proposalFamily, 'COVERAGE_GAP');
  assert.equal(proposal.country, 'DE');
  assert.equal(proposal.concept, 'DAX hebelprodukte');
  assert.equal(proposal.trialStatus, 'PENDING');
  assert.equal(proposal.confidence, 0.8);
  assert.ok(proposal.expiresAt, 'Proposal must have expiry timestamp');
  assert.ok(new Date(proposal.expiresAt!).getTime() > Date.now(), 'Expiry must be in the future');
  assert.ok(proposal.targetNeighborhoodKey?.includes('de'), 'Target neighborhood key must include lowercased country');
});

test('Phase 6: Country-native proposal generator uses native market terms without English translation', async () => {
  const proposalsJP = await generateCountryNativeProposals('JP', 5);
  assert.ok(proposalsJP.length > 0);
  assert.equal(proposalsJP[0].proposalFamily, 'COUNTRY_NATIVE');
  assert.equal(proposalsJP[0].country, 'Japan');
  assert.ok(proposalsJP.some(p => p.concept.includes('日経平均') || p.concept.includes('FX')), 'Japanese native terms must be present');

  const proposalsBR = await generateCountryNativeProposals('BR', 5);
  assert.ok(proposalsBR.length > 0);
  assert.equal(proposalsBR[0].country, 'Brazil');
  assert.ok(proposalsBR.some(p => p.concept.includes('B3') || p.concept.includes('mini indice')), 'Brazilian native terms must be present');
});
