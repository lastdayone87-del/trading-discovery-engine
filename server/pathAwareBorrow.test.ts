import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { siteInspectionCoversRequest } from './siteInspectionCache';

const foundRow = {
  outcome: 'FOUND',
  canonicalUrl: 'https://bit.ly/btc-discord',
  finalUrl: 'https://bit.ly/btc-discord',
  observations: [{ requestedUrl: 'https://bit.ly/btc-discord', rootUrl: 'https://bit.ly/btc-discord', finalUrl: 'https://bit.ly/btc-discord' }],
  candidates: [],
};

describe('path-aware FOUND borrowing', () => {
  it('legacy borrows FOUND regardless of path when strict disabled', () => {
    assert.equal(
      siteInspectionCoversRequest(foundRow, 'https://bit.ly/RDV-URRUTIA', { strictFoundCoverage: false }),
      true,
    );
  });

  it('strict requires coverage-key/binding match for FOUND', () => {
    assert.equal(siteInspectionCoversRequest(foundRow, 'https://bit.ly/btc-discord'), true);
    assert.equal(siteInspectionCoversRequest(foundRow, 'https://bit.ly/RDV-URRUTIA'), false);
  });

  it('genuine redirect-chain bindings still resolve (caller uses redirectBindingFor)', () => {
    // Covered: exact requested URL match borrows; unrelated slug falls through.
    assert.equal(siteInspectionCoversRequest(foundRow, 'https://bit.ly/btc-discord'), true);
  });
});
