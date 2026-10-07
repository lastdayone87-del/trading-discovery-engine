import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  effectiveAcquisitionOutcomes,
} from './communitySurfacePolicy';
import {
  isCommunityRelevantObservation,
  isMeaningfulWebsiteObservation,
  hasProcessedAcquisitionEvidence,
} from './inspector';
import {
  isCommunityRetryableObservation,
  hasRetryableCommunityAcquisitionFailure,
} from './communityRetryPolicy';

/**
 * Terminal-only barrier channel case: a relevant permanent barrier
 * (LOGIN_WALL PARTIAL, non-retryable) as the only remaining unresolved
 * acquisition evidence must:
 * - remain visible as genuine acquisition failure/incomplete (PARTIAL, never
 *   INSPECTED_NO_MATCH),
 * - own outcome incompleteness via community relevance (not auxiliary),
 * - never own retry (terminal → hasRetryable false → no RETRY DUE),
 * - project to FAILED_OPERATIONAL / scan FAILED / discord UNCERTAIN
 *   (existing queueManager mapping: hasRetryable ? RETRY_PENDING :
 *   FAILED_OPERATIONAL; verified by code reference, not duplicated here).
 */
describe('terminal permanent barrier channel state (relevant-only unresolved)', () => {
  const barrier = {
    requestedUrl: 'https://www.instagram.com/somecreator',
    rootUrl: 'https://www.instagram.com/somecreator',
    surface: 'SOCIAL_PROFILES',
    required: true,
    outcome: 'PARTIALLY_INSPECTED',
    retryable: false,
    failureClass: 'LOGIN_WALL',
    telemetry: { pagesInspected: 1, requestsStarted: 1, redirectsFollowed: 1 },
  };

  it('barrier stays relevant and meaningful (PR504 preserved)', () => {
    assert.equal(isMeaningfulWebsiteObservation(barrier), true);
    // Instagram social surface is not auxiliary: relevant terminal barrier
    // contributes to acquisition failure (auxiliary still excluded).
    assert.equal(isCommunityRelevantObservation(barrier as never), true);
  });

  it('barrier never becomes INSPECTED_NO_MATCH (inaccessibility ≠ clean)', () => {
    const collapsed = effectiveAcquisitionOutcomes([
      { ...barrier, outcome: 'PARTIALLY_INSPECTED' },
    ] as never);
    assert.equal(collapsed[0].outcome, 'PARTIALLY_INSPECTED');
    assert.notEqual(collapsed[0].outcome, 'INSPECTED_NO_MATCH');
  });

  it('barrier never owns retry (terminal → no RETRY DUE)', () => {
    assert.equal(isCommunityRetryableObservation(barrier as never), false);
    assert.equal(hasRetryableCommunityAcquisitionFailure([barrier] as never), false);
  });

  it('processed evidence keeps it visible (not unevidenced)', () => {
    assert.equal(hasProcessedAcquisitionEvidence(barrier as never), true);
  });

  it('PAYWALL_WALL and PERMANENT_ACCESS_BLOCK behave identically terminal', () => {
    for (const failureClass of ['PAYWALL_WALL', 'PERMANENT_ACCESS_BLOCK']) {
      const row = { ...barrier, failureClass };
      assert.equal(isCommunityRelevantObservation(row as never), true);
      assert.equal(isCommunityRetryableObservation(row as never), false);
      assert.equal(hasRetryableCommunityAcquisitionFailure([row] as never), false);
    }
  });

  it('transient 403/429 remains retryable (uncertain → retryable)', () => {
    const transient = {
      ...barrier,
      outcome: 'ACQUISITION_FAILED',
      retryable: true,
      failureClass: 'HTTP_ERROR',
    };
    assert.equal(isCommunityRetryableObservation(transient as never), true);
    assert.equal(hasRetryableCommunityAcquisitionFailure([transient] as never), true);
  });
});
