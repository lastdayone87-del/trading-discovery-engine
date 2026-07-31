import assert from 'node:assert/strict';
import test from 'node:test';
import { admitOrganicQueryCandidates, ORGANIC_QUERY_POLICY_VERSION, type OrganicQueryCandidate } from './organicQueryExpansion';

const candidate = (overrides: Partial<OrganicQueryCandidate> = {}): OrganicQueryCandidate => ({
  candidateId: 'candidate-1', conceptId: 'concept-order-flow', surface: 'Flujo de órdenes',
  sourceType: 'PLAYLIST_TOPIC', sourceRefs: ['playlist:PL1:title:0-16'], independentSourceIds: ['creator:A', 'creator:B'],
  language: 'es', script: 'Latn', locale: 'es-ES', intent: 'strategy', lifecycle: 'SEARCH_TRIAL',
  validation: { language: true, script: true, safety: true, retrievalShape: true, policyVersion: ORGANIC_QUERY_POLICY_VERSION },
  trial: { experimentId: 'experiment-1', armKey: 'organic', assignmentCap: 10, quotaCap: 100 }, ...overrides
});

test('admits independently corroborated, validated and quota-limited organic trials', () => {
  const admitted = admitOrganicQueryCandidates([candidate()]);
  assert.equal(admitted.length, 1);
  assert.equal(admitted[0].eligibilityReason, 'QUOTA_LIMITED_CONTROLLED_TRIAL');
  assert.match(admitted[0].provenanceChecksum, /^[a-f0-9]{64}$/);
});

test('fails closed for unsupported lifecycle, missing corroboration, validation or trial controls', () => {
  assert.equal(admitOrganicQueryCandidates([candidate({ lifecycle: 'VALIDATED' })]).length, 0);
  assert.equal(admitOrganicQueryCandidates([candidate({ independentSourceIds: ['creator:A', 'creator:A'] })]).length, 0);
  assert.equal(admitOrganicQueryCandidates([candidate({ validation: { ...candidate().validation, safety: false } })]).length, 0);
  assert.equal(admitOrganicQueryCandidates([candidate({ trial: undefined })]).length, 0);
});

test('requires an immutable published catalog pin for proven candidates', () => {
  assert.equal(admitOrganicQueryCandidates([candidate({ lifecycle: 'PROVEN', trial: undefined })]).length, 0);
  const admitted = admitOrganicQueryCandidates([candidate({ lifecycle: 'PROVEN', trial: undefined, catalog: { versionId: 'catalog-1', checksum: 'abc', pointerVersion: 2 } })]);
  assert.equal(admitted[0].eligibilityReason, 'PUBLISHED_PROVEN_CANDIDATE');
});
