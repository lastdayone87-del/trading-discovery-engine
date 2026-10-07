import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  isCommunityRetryableObservation,
  hasRetryableCommunityAcquisitionFailure,
  STATIC_BUDGET_GAP_FAILURE_CLASS,
} from './communityRetryPolicy';

describe('retry ownership preserves PR504, excludes BLOCK/terminal, allows static gaps', () => {
  it('BLOCK tier never owns retry', () => {
    assert.equal(
      isCommunityRetryableObservation({
        required: true,
        surface: 'CREATOR_WEBSITES',
        outcome: 'ACQUISITION_FAILED',
        retryable: true,
        failureClass: 'RENDERED_TIMEOUT',
        requestedUrl: 'https://calendly.com/x/book',
        relevanceTier: 'BLOCK',
      } as unknown as Parameters<typeof isCommunityRetryableObservation>[0]),
      false,
    );
  });

  it('DEMOTE tier never owns retry (bounded static evidence retained, no worker spend)', () => {
    assert.equal(
      isCommunityRetryableObservation({
        required: false,
        surface: 'CREATOR_WEBSITES',
        outcome: 'PARTIALLY_INSPECTED',
        retryable: true,
        failureClass: 'STATIC_BUDGET_GAP',
        requestedUrl: 'https://amzn.to/3ovQMLW',
        relevanceTier: 'DEMOTE',
      } as unknown as Parameters<typeof isCommunityRetryableObservation>[0]),
      false,
    );
  });

  it('LOGIN_WALL never owns retry (terminal class guard, proven with retryable:true)', () => {
    assert.equal(
      isCommunityRetryableObservation({
        required: true,
        surface: 'CREATOR_WEBSITES',
        outcome: 'PARTIALLY_INSPECTED',
        retryable: true,
        failureClass: 'LOGIN_WALL',
        requestedUrl: 'https://example.com/page',
      }),
      false,
    );
  });

  it('PAYWALL_WALL never owns retry (terminal class guard, proven with retryable:true)', () => {
    assert.equal(
      isCommunityRetryableObservation({
        required: true,
        surface: 'CREATOR_WEBSITES',
        outcome: 'PARTIALLY_INSPECTED',
        retryable: true,
        failureClass: 'PAYWALL_WALL',
        requestedUrl: 'https://example.com/article/1',
      }),
      false,
    );
  });

  it('PERMANENT_ACCESS_BLOCK never owns retry (terminal class guard)', () => {
    assert.equal(
      isCommunityRetryableObservation({
        required: true,
        surface: 'CREATOR_WEBSITES',
        outcome: 'ACQUISITION_FAILED',
        retryable: true,
        failureClass: 'PERMANENT_ACCESS_BLOCK',
        requestedUrl: 'https://example.com/page',
      }),
      false,
    );
  });

  it('STATIC_BUDGET_GAP partial owns bounded retry even with required=false', () => {
    assert.equal(
      isCommunityRetryableObservation({
        required: false,
        surface: 'CREATOR_WEBSITES',
        outcome: 'PARTIALLY_INSPECTED',
        retryable: true,
        failureClass: STATIC_BUDGET_GAP_FAILURE_CLASS,
        requestedUrl: 'https://example.com/page',
      }),
      true,
    );
  });

  it('PR504 auxiliary still never owns retry', () => {
    assert.equal(
      isCommunityRetryableObservation({
        required: true,
        surface: 'CREATOR_WEBSITES',
        outcome: 'ACQUISITION_FAILED',
        retryable: true,
        failureClass: 'RENDERED_TIMEOUT',
        requestedUrl: 'https://broker.test/referral/creator',
      }),
      false,
    );
  });
});

describe('retry aggregate admits eligible static gaps (required=false)', () => {
  const gap = {
    required: false,
    surface: 'CREATOR_WEBSITES',
    requestedUrl: 'https://example.com/page',
    outcome: 'PARTIALLY_INSPECTED',
    retryable: true,
    failureClass: STATIC_BUDGET_GAP_FAILURE_CLASS,
  };
  it('eligible STATIC_BUDGET_GAP owns the aggregate retry path', () => {
    assert.equal(hasRetryableCommunityAcquisitionFailure([gap] as never), true);
  });
  it('DEMOTE STATIC_BUDGET_GAP stays non-owning end to end', () => {
    assert.equal(
      hasRetryableCommunityAcquisitionFailure([{ ...gap, relevanceTier: 'DEMOTE' }] as never),
      false,
    );
  });
});
