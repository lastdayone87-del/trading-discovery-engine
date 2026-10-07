import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { siteInspectionCoversRequest, isExactBarrierPageCover } from './siteInspectionCache';

const foundRow = {
  outcome: 'FOUND',
  canonicalUrl: 'https://bit.ly/btc-discord',
  finalUrl: 'https://bit.ly/btc-discord',
  observations: [{ requestedUrl: 'https://bit.ly/btc-discord', rootUrl: 'https://bit.ly/btc-discord', finalUrl: 'https://bit.ly/btc-discord' }],
  candidates: [],
};

// Redirect-bound FOUND: the row was captured through a redirect chain — the
// lender requested the short URL but the destination holds the evidence.
// Borrowers of the exact destination still match; unrelated slugs do not.
const redirectBoundRow = {
  outcome: 'FOUND',
  canonicalUrl: 'https://tradeify.co/?ref=RDF',
  finalUrl: 'https://tradeify.co/?ref=RDF',
  observations: [
    { requestedUrl: 'https://bit.ly/TradeifySale', rootUrl: 'https://bit.ly/TradeifySale', finalUrl: 'https://tradeify.co/?ref=RDF' },
    { requestedUrl: 'https://tradeify.co/?ref=RDF', rootUrl: 'https://tradeify.co/?ref=RDF', finalUrl: 'https://tradeify.co/?ref=RDF' },
  ],
  candidates: [],
};

describe('path-aware FOUND borrowing', () => {
  it('legacy default (options omitted) borrows FOUND regardless of path', () => {
    // Backward compatibility: callers that do not opt in keep prior behavior.
    assert.equal(siteInspectionCoversRequest(foundRow, 'https://bit.ly/RDV-URRUTIA'), true);
    assert.equal(
      siteInspectionCoversRequest(foundRow, 'https://bit.ly/RDV-URRUTIA', { strictFoundCoverage: false }),
      true,
    );
  });

  it('strict opt-in requires coverage-key/binding match for FOUND', () => {
    assert.equal(
      siteInspectionCoversRequest(foundRow, 'https://bit.ly/btc-discord', { strictFoundCoverage: true }),
      true,
    );
    assert.equal(
      siteInspectionCoversRequest(foundRow, 'https://bit.ly/RDV-URRUTIA', { strictFoundCoverage: true }),
      false,
    );
  });

  it('redirect-bound destination borrows under strict; unrelated slug falls through', () => {
    // Requested short URL differs from the resolved destination row, yet the
    // destination request itself is covered by the row's observations.
    assert.equal(
      siteInspectionCoversRequest(redirectBoundRow, 'https://tradeify.co/?ref=RDF', { strictFoundCoverage: true }),
      true,
    );
    assert.equal(
      siteInspectionCoversRequest(redirectBoundRow, 'https://bit.ly/TradeifySale', { strictFoundCoverage: true }),
      true,
    );
    assert.equal(
      siteInspectionCoversRequest(redirectBoundRow, 'https://bit.ly/OtherSlug', { strictFoundCoverage: true }),
      false,
    );
  });
});

describe('exact barrier page cover (terminal rows)', () => {
  const loginRow = {
    canonicalUrl: 'https://www.instagram.com/someprofile',
    finalUrl: 'https://www.instagram.com/accounts/login/?next=/someprofile',
    observations: [
      { requestedUrl: 'https://www.instagram.com/someprofile', rootUrl: 'https://www.instagram.com/someprofile', finalUrl: 'https://www.instagram.com/accounts/login/?next=/someprofile' },
    ],
  };
  it('same exact page (requested/root/final) stays covered', () => {
    assert.equal(isExactBarrierPageCover(loginRow, 'https://www.instagram.com/someprofile'), true);
    assert.equal(
      isExactBarrierPageCover(loginRow, 'https://www.instagram.com/accounts/login/?next=/someprofile'),
      true,
    );
  });
  it('another path on the same host is not covered (recrawls)', () => {
    assert.equal(isExactBarrierPageCover(loginRow, 'https://www.instagram.com/otherprofile'), false);
  });
  it('fails closed on missing input', () => {
    assert.equal(isExactBarrierPageCover(null as never, 'https://example.com/'), false);
    assert.equal(isExactBarrierPageCover(loginRow, ''), false);
  });
});
