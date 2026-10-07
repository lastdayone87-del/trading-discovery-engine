import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  isCommunityRetryableObservation,
  STATIC_BUDGET_GAP_FAILURE_CLASS,
} from './communityRetryPolicy';

describe('retry ownership preserves PR504, excludes BLOCKED/LOGIN_WALL, allows static gaps', () => {
  it('BLOCKED tier never owns retry', () => {
    assert.equal(
      isCommunityRetryableObservation({
        required: true,
        surface: 'CREATOR_WEBSITES',
        outcome: 'ACQUISITION_FAILED',
        retryable: true,
        failureClass: 'RENDERED_TIMEOUT',
        requestedUrl: 'https://calendly.com/x/book',
        relevanceTier: 'BLOCKED',
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

  it('LOGIN_WALL never owns retry (terminal)', () => {
    assert.equal(
      isCommunityRetryableObservation({
        required: true,
        surface: 'CREATOR_WEBSITES',
        outcome: 'PARTIALLY_INSPECTED',
        retryable: false,
        failureClass: 'LOGIN_WALL',
        requestedUrl: 'https://example.com/page',
      }),
      false,
    );
  });

  it('PAYWALL_WALL never owns retry (terminal)', () => {
    assert.equal(
      isCommunityRetryableObservation({
        required: true,
        surface: 'CREATOR_WEBSITES',
        outcome: 'PARTIALLY_INSPECTED',
        retryable: false,
        failureClass: 'PAYWALL_WALL',
        requestedUrl: 'https://example.com/article/1',
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
