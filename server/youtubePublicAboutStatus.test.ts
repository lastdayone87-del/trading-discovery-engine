import assert from 'node:assert/strict';
import test from 'node:test';
import { fetchPublicAboutEvidence, resetPublicAboutPacingForTests } from './youtubePublicAbout';

function htmlResponse(body: string, init: { status?: number; contentType?: string } = {}): Response {
  return new Response(body, {
    status: init.status || 200,
    headers: { 'content-type': init.contentType || 'text/html' },
  });
}

test('public About distinguishes available evidence from authoritative empty', async () => {
  resetPublicAboutPacingForTests();
  const available = await fetchPublicAboutEvidence('https://www.youtube.com/channel/UCtest', async () =>
    htmlResponse('<html><head><meta property="og:description" content="NQ futures trader. Live execution and risk management."></head></html>'));
  assert.equal(available.status, 'AVAILABLE');
  assert.match(available.about?.bio || '', /NQ futures trader/);

  const empty = await fetchPublicAboutEvidence('https://www.youtube.com/channel/UCtest', async () =>
    htmlResponse('<html><head><title>YouTube</title></head><body>No about text</body></html>'));
  assert.equal(empty.status, 'AUTHORITATIVE_EMPTY');
});

test('a subscriber-only About page is usable metadata, not authoritative empty', async () => {
  resetPublicAboutPacingForTests();
  const html = `<script>var ytInitialData = ${JSON.stringify({
    contents: [{ aboutChannelRenderer: { metadata: { aboutChannelViewModel: { subscriberCountText: '12.3K subscribers' } } } }],
  })};</script>`;
  const subscriberOnly = await fetchPublicAboutEvidence('https://www.youtube.com/channel/UCtest', async () =>
    htmlResponse(html));
  assert.equal(subscriberOnly.status, 'AVAILABLE');
  assert.equal(subscriberOnly.about?.subscriberCountText, '12.3K subscribers');
});

test('one empty surface plus one temporary failure stays retryable', async () => {
  resetPublicAboutPacingForTests();
  const mixed = await fetchPublicAboutEvidence('https://www.youtube.com/channel/UCtest', async (input) => {
    if (String(input).includes('/about')) {
      return htmlResponse('<html><head><title>YouTube</title></head><body>No about text</body></html>');
    }
    throw new Error('socket hang up');
  });
  assert.equal(mixed.status, 'TEMPORARY_FAILURE');
});

test('an empty 200 body is incomplete, not authoritative empty', async () => {
  resetPublicAboutPacingForTests();
  const empty = await fetchPublicAboutEvidence('https://www.youtube.com/channel/UCtest', async () =>
    htmlResponse(''));
  assert.equal(empty.status, 'INCOMPLETE_RESPONSE');
});

test('public About temporary failures never become authoritative empty', async () => {
  resetPublicAboutPacingForTests();
  const rateLimited = await fetchPublicAboutEvidence('https://www.youtube.com/channel/UCtest', async () =>
    htmlResponse('too many requests', { status: 429 }));
  assert.equal(rateLimited.status, 'RATE_LIMITED');
  resetPublicAboutPacingForTests();

  const consent = await fetchPublicAboutEvidence('https://www.youtube.com/channel/UCtest', async () =>
    htmlResponse('<html><body>Before you continue to YouTube. We use cookies and data.</body></html>'));
  // The companion surface may observe the consent cooldown as RATE_LIMITED;
  // either way this must never become AUTHORITATIVE_EMPTY.
  assert.ok(['CONSENT_BLOCKED', 'RATE_LIMITED'].includes(consent.status), consent.status);
  resetPublicAboutPacingForTests();

  const outage = await fetchPublicAboutEvidence('https://www.youtube.com/channel/UCtest', async () => {
    throw new Error('socket hang up');
  });
  assert.equal(outage.status, 'TEMPORARY_FAILURE');
});

test('rate-limited public About enters a cooldown instead of hammering YouTube', async () => {
  resetPublicAboutPacingForTests();
  const limited = await fetchPublicAboutEvidence('https://www.youtube.com/channel/UCtest', async () =>
    htmlResponse('too many requests', { status: 429 }));
  assert.equal(limited.status, 'RATE_LIMITED');
  let calls = 0;
  const cooldown = await fetchPublicAboutEvidence('https://www.youtube.com/channel/UCtest', async () => {
    calls += 1;
    return htmlResponse('<html></html>');
  });
  assert.equal(cooldown.status, 'RATE_LIMITED');
  assert.equal(calls, 0);
  resetPublicAboutPacingForTests();
});
