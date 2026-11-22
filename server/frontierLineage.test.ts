import assert from 'node:assert/strict';
import test from 'node:test';
import { shouldConsumeFrontierProposal } from './frontierLineage';

test('materialized-generated lineage without a governed proposal is not consumed', () => {
  assert.equal(shouldConsumeFrontierProposal({
    hasNeighborhoodLineage: true,
    proposalId: null,
  }), false);
  assert.equal(shouldConsumeFrontierProposal({
    hasNeighborhoodLineage: true,
    proposalId: undefined,
  }), false);
});

test('a governed frontier proposal is consumed only with lineage and an id', () => {
  assert.equal(shouldConsumeFrontierProposal({
    hasNeighborhoodLineage: true,
    proposalId: '00000000-0000-4000-8000-000000000125',
  }), true);
  assert.equal(shouldConsumeFrontierProposal({
    hasNeighborhoodLineage: false,
    proposalId: '00000000-0000-4000-8000-000000000125',
  }), false);
});
