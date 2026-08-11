import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { submitReviewDecision } from '../src/reviewDecision';

test('review decision helper submits exactly one POST with governed reason metadata', async () => {
  const calls: Array<{url:string;init?:RequestInit}> = [];
  const fetcher = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    return new Response(JSON.stringify({
      decision: { decision: 'REJECT', resulting_status: 'HUMAN_REJECTED', review_version: 4 },
      review: { state: 'REJECTED', reviewVersion: 4 },
      channel: { channelId: 'channel-1', tradingStatus: 'HUMAN_REJECTED', scanStatus: 'COMPLETED', discordStatus: 'NOT_FOUND' },
      queuePending: false,
      idempotent: false
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;

  const result = await submitReviewDecision({
    channelId: 'channel-1',
    action: 'reject',
    reviewVersion: 3,
    reviewReasonCode: 'NOT_TRADING_CREATOR',
    reviewReasonVersion: 'review-reasons-v1',
    notes: 'human reviewed'
  }, fetcher, { Authorization: 'Bearer test', 'X-Reviewer-Id': 'reviewer' }, 'stable-idempotency-key');

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, '/api/reviews/channel-1/reject');
  assert.equal(calls[0].init?.method, 'POST');
  const headers = calls[0].init?.headers as Record<string,string>;
  assert.equal(headers['Idempotency-Key'], 'stable-idempotency-key');
  const body = JSON.parse(String(calls[0].init?.body));
  assert.deepEqual({
    reviewVersion: body.reviewVersion,
    reviewReasonCode: body.reviewReasonCode,
    reviewReasonVersion: body.reviewReasonVersion,
    notes: body.notes
  }, {
    reviewVersion: 3,
    reviewReasonCode: 'NOT_TRADING_CREATOR',
    reviewReasonVersion: 'review-reasons-v1',
    notes: 'human reviewed'
  });
  assert.equal(result.channel.tradingStatus, 'HUMAN_REJECTED');
  assert.equal(result.queuePending, false);
});

test('review table requires an explicit confirmation submit and closes decision state only after success', () => {
  const source = readFileSync(new URL('../src/components/ResultsTable.tsx', import.meta.url), 'utf8');
  assert.match(source, /<form[^>]+onSubmit=/);
  assert.match(source, /Confirm \{pendingDecision\.action\}/);
  assert.match(source, /setPendingDecision\(null\)/);
  assert.match(source, /setDecidedChannelIds\(/);
  assert.match(source, /setReviewSuccess\(/);
  assert.ok(source.indexOf('await submitReviewDecision') < source.indexOf('setPendingDecision(null)'), 'dialog must close only after submit resolves');
});

test('mobile review modal keeps the final action bar reachable', () => {
  const css = readFileSync(new URL('../src/index.css', import.meta.url), 'utf8');
  assert.match(css, /\[aria-labelledby="decision-reason-title"\] form \{/);
  assert.match(css, /overflow-y:\s*auto/);
  assert.match(css, /position:\s*sticky/);
  assert.match(css, /max-height:\s*92dvh/);
});
