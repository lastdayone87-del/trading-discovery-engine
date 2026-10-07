import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  isConclusivePermanentBlock,
  hasBlockMarkers,
  PERMANENT_ACCESS_BLOCK_FAILURE_CLASS,
} from './permanentBlockDetection';

describe('conclusive permanent block (bounded identical retries + markers)', () => {
  const current = {
    requestedUrl: 'https://example.com/page',
    failureClass: 'HTTP_ERROR',
    httpStatus: 403,
    finalUrl: 'https://example.com/page',
    outcome: 'ACQUISITION_FAILED',
    pagesInspected: 0,
    hasCandidates: false,
    blockMarkers: true,
  };
  const identicalPrior = (observedAt: string) => ({
    requestedUrl: 'https://example.com/page',
    failureClass: 'HTTP_ERROR',
    httpStatus: 403,
    finalUrl: 'https://example.com/page',
    outcome: 'ACQUISITION_FAILED',
    pagesInspected: 0,
    hasCandidates: false,
  });

  it('single failure never permanent (uncertain → retryable)', () => {
    assert.equal(isConclusivePermanentBlock({ current, history: [] }), false);
    assert.equal(
      isConclusivePermanentBlock({ current, history: [identicalPrior('2026-10-01')] }),
      false,
    );
  });

  it('three identical attempts with markers establish permanence', () => {
    assert.equal(
      isConclusivePermanentBlock({
        current,
        history: [identicalPrior('2026-10-05'), identicalPrior('2026-10-06')],
      }),
      true,
    );
    assert.equal(PERMANENT_ACCESS_BLOCK_FAILURE_CLASS, 'PERMANENT_ACCESS_BLOCK');
  });

  it('fails closed on missing status/markers/drifted final/intervening success', () => {
    const noMarkers = { ...current, blockMarkers: false };
    assert.equal(
      isConclusivePermanentBlock({
        current: noMarkers,
        history: [identicalPrior('2026-10-05'), identicalPrior('2026-10-06')],
      }),
      false,
    );
    const drifted = { ...current };
    assert.equal(
      isConclusivePermanentBlock({
        current: drifted,
        history: [
          identicalPrior('2026-10-05'),
          { ...identicalPrior('2026-10-06'), finalUrl: 'https://other.example/page' },
        ],
      }),
      false,
    );
    const interveningSuccess = { ...current };
    assert.equal(
      isConclusivePermanentBlock({
        current: interveningSuccess,
        history: [
          identicalPrior('2026-10-05'),
          { ...identicalPrior('2026-10-06'), outcome: 'FOUND' },
        ],
      }),
      false,
    );
    // Legacy history rows without httpStatus never establish permanence.
    const legacyRow = { requestedUrl: 'https://example.com/page', failureClass: 'HTTP_ERROR', outcome: 'ACQUISITION_FAILED' };
    assert.equal(isConclusivePermanentBlock({ current, history: [legacyRow, legacyRow] }), false);
  });

  it('429/999/NO_PAGE/network never permanent even repeated', () => {
    for (const failureClass of ['RATE_LIMIT', 'TRANSIENT_HTTP', 'NO_PAGE_PROCESSED', 'NETWORK_FAILURE', 'TIMEOUT']) {
      assert.equal(
        isConclusivePermanentBlock({
          current: { ...current, failureClass },
          history: [identicalPrior('2026-10-05'), identicalPrior('2026-10-06')],
        }),
        false,
        failureClass,
      );
    }
  });

  it('block markers detect WAF pages, ignore ordinary text', () => {
    assert.equal(hasBlockMarkers('<html>Attention Required! cf-chl Cloudflare</html>'), true);
    assert.equal(hasBlockMarkers('<html>hello world</html>'), false);
    assert.equal(hasBlockMarkers(''), false);
  });
});

describe('permanent-block streak reset (intervening nonmatch breaks permanence)', () => {
  const matching = (observedAt: string) => ({
    requestedUrl: 'https://example.com/page',
    failureClass: 'HTTP_ERROR',
    httpStatus: 403,
    finalUrl: 'https://example.com/page',
    outcome: 'ACQUISITION_FAILED',
    pagesInspected: 0,
    hasCandidates: false,
    observedAt,
  });
  const current = {
    requestedUrl: 'https://example.com/page',
    failureClass: 'HTTP_ERROR',
    httpStatus: 403,
    finalUrl: 'https://example.com/page',
    outcome: 'ACQUISITION_FAILED',
    pagesInspected: 0,
    hasCandidates: false,
    blockMarkers: true,
  };
  it('intervening success resets the streak (older matches do not count)', () => {
    assert.equal(
      isConclusivePermanentBlock({
        current,
        history: [
          matching('2026-10-01'),
          matching('2026-10-02'),
          { ...matching('2026-10-03'), outcome: 'FOUND' },
          matching('2026-10-04'),
        ],
      }),
      false,
    );
  });
  it('intervening different-status/different-host resets the streak', () => {
    assert.equal(
      isConclusivePermanentBlock({
        current,
        history: [
          matching('2026-10-01'),
          matching('2026-10-02'),
          { ...matching('2026-10-03'), httpStatus: 500, failureClass: 'TRANSIENT_HTTP' },
          matching('2026-10-04'),
        ],
      }),
      false,
    );
    assert.equal(
      isConclusivePermanentBlock({
        current,
        history: [
          matching('2026-10-01'),
          matching('2026-10-02'),
          { ...matching('2026-10-03'), finalUrl: 'https://other.example/page' },
          matching('2026-10-04'),
        ],
      }),
      false,
    );
  });
  it('uninterrupted trailing run of 2+ still establishes permanence', () => {
    assert.equal(
      isConclusivePermanentBlock({
        current,
        history: [
          { ...matching('2026-10-01'), outcome: 'FOUND' },
          matching('2026-10-05'),
          matching('2026-10-06'),
        ],
      }),
      true,
    );
  });
});
