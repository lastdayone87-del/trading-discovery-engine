import assert from 'node:assert/strict';
import test from 'node:test';
import { fetchPublicAboutEvidence } from './youtubePublicAbout';

function htmlResponse(body: string, init: { status?: number; contentType?: string } = {}): Response {
  return new Response(body, {
    status: init.status || 200,
    headers: { 'content-type': init.contentType || 'text/html' },
  });
}

test('public About distinguishes available evidence from authoritative empty', async () => {
  const available = await fetchPublicAboutEvidence('https://www.youtube.com/channel/UCtest', async () =>
    htmlResponse('<html><head><meta property="og:description" content="NQ futures trader. Live execution and risk management."></head></html>'));
  assert.equal(available.status, 'AVAILABLE');
  assert.match(available.about?.bio || '', /NQ futures trader/);

  const empty = await fetchPublicAboutEvidence('https://www.youtube.com/channel/UCtest', async () =>
    htmlResponse('<html><head><title>YouTube</title></head><body>No about text</body></html>'));
  assert.equal(empty.status, 'AUTHORITATIVE_EMPTY');
});

test('public About temporary failures never become authoritative empty', async () => {
  const rateLimited = await fetchPublicAboutEvidence('https://www.youtube.com/channel/UCtest', async () =>
    htmlResponse('too many requests', { status: 429 }));
  assert.equal(rateLimited.status, 'RATE_LIMITED');

  const consent = await fetchPublicAboutEvidence('https://www.youtube.com/channel/UCtest', async () =>
    htmlResponse('<html><body>Before you continue to YouTube. We use cookies and data.</body></html>'));
  assert.equal(consent.status, 'CONSENT_BLOCKED');

  const outage = await fetchPublicAboutEvidence('https://www.youtube.com/channel/UCtest', async () => {
    throw new Error('socket hang up');
  });
  assert.equal(outage.status, 'TEMPORARY_FAILURE');
});
