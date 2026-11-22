import assert from 'node:assert/strict';
import test from 'node:test';
import { youtubeRequestSignature, youtubeRequestSignatureFromUrl } from './youtubeQuarantineSignature';

test('request signature changes with provider, operation, and relevant parameters', () => {
  const base = youtubeRequestSignature('youtube', 'search', {
    type: 'video', order: 'date', regionCode: 'LU', relevanceLanguage: 'fr',
  });
  assert.notEqual(base, youtubeRequestSignature('youtube-innertube', 'search', {
    type: 'video', order: 'date', regionCode: 'LU', relevanceLanguage: 'fr',
  }));
  assert.notEqual(base, youtubeRequestSignature('youtube', 'search', {
    type: 'video', order: 'date', regionCode: 'LU', relevanceLanguage: 'lb',
  }));
  assert.notEqual(base, youtubeRequestSignature('youtube', 'recent-videos-search', {
    type: 'video', order: 'date', regionCode: 'LU', relevanceLanguage: 'fr',
  }));
});

test('request signature is stable and ignores dispatch-only parameters', () => {
  const a = youtubeRequestSignature('youtube', 'search', {
    q: 'trading luxx', part: 'snippet', type: 'video', order: 'relevance',
  });
  const b = youtubeRequestSignatureFromUrl(
    'youtube',
    'search',
    'https://youtube.googleapis.com/youtube/v3/search?part=snippet&q=trading+luxx&type=video&order=relevance&key=secret',
  );
  assert.equal(a, b);
});
