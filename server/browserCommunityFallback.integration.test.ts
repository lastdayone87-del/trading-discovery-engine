import test from 'node:test';
import assert from 'node:assert/strict';
import { runChannelInspection } from './inspector';
import type { BrowserFallbackResult } from './browserCommunityFallback';

const staticNoMatchFetch: typeof fetch = async () => new Response(
  '<html><body><a href="/about">About</a><p>Trading education</p></body></html>',
  { status: 200, headers: { 'content-type': 'text/html' } },
);

const baseInput = {
  channelId: 'UC_RENDERED_FALLBACK_TEST',
  channelBio: 'Trading creator with an official website.',
  channelLinks: ['https://creator.example/'],
  videoDescriptions: ['', '', '', '', ''],
  externalFetchImpl: staticNoMatchFetch,
};

test('confirmed trading creator escalates static website no-match and retains rendered Discord candidate', async () => {
  let renderedCalls = 0;
  const renderedFallback = async (): Promise<BrowserFallbackResult> => {
    renderedCalls++;
    return {
      foundInvite: 'TraderRoom123',
      foundLocation: 'https://creator.example/community',
      inspectedPages: 2,
      scrolls: 1,
      clicks: 1,
      complete: true,
      retryable: false,
      detail: 'Discord invite discovered by rendered fallback',
    };
  };

  const result = await runChannelInspection({
    ...baseInput,
    creatorLikelyTrading: true,
    renderedFallback,
  });

  assert.equal(renderedCalls, 1);
  assert.equal(result.foundInvite, 'TraderRoom123');
  assert.equal(result.acquisitionStatus, 'FOUND');
  assert.ok(result.discordCandidates?.some(candidate => candidate.nativeInviteCode === 'TraderRoom123'));
  assert.ok(result.acquisitionOutcomes?.some(observation => observation.surface === 'CREATOR_WEBSITES' && observation.required && observation.outcome === 'FOUND'));
});

test('non-trading creator never invokes rendered fallback after static website no-match', async () => {
  let renderedCalls = 0;
  const renderedFallback = async (): Promise<BrowserFallbackResult> => {
    renderedCalls++;
    throw new Error('browser must not launch');
  };

  const result = await runChannelInspection({
    ...baseInput,
    creatorLikelyTrading: false,
    renderedFallback,
  });

  assert.equal(renderedCalls, 0);
  assert.equal(result.foundInvite, null);
});

test('rendered acquisition failure becomes required retryable uncertainty', async () => {
  const renderedFallback = async (): Promise<BrowserFallbackResult> => ({
    foundInvite: null,
    inspectedPages: 1,
    scrolls: 0,
    clicks: 0,
    complete: false,
    retryable: true,
    detail: 'Rendered acquisition budget expired before coverage completed',
  });

  const result = await runChannelInspection({
    ...baseInput,
    creatorLikelyTrading: true,
    renderedFallback,
  });

  const renderedObservation = result.acquisitionOutcomes?.find(observation => observation.failureClass === 'RENDERED_ACQUISITION_INCOMPLETE');
  assert.ok(renderedObservation);
  assert.equal(renderedObservation?.required, true);
  assert.equal(renderedObservation?.retryable, true);
  assert.equal(renderedObservation?.outcome, 'ACQUISITION_FAILED');
  assert.equal(result.acquisitionStatus, 'ACQUISITION_FAILED');
});
