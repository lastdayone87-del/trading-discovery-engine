import assert from 'node:assert/strict';
import test from 'node:test';
import { buildYouTubeApiUrl } from './youtube';

test('buildYouTubeApiUrl constructs a canonical request without quotaUser identity', () => {
  const previous = process.env.YOUTUBE_QUOTA_USER;
  process.env.YOUTUBE_QUOTA_USER = 'railway discovery/production';
  try {
    const request = new URL(buildYouTubeApiUrl('search', 'key+with/&symbols', {
      part: 'snippet', type: 'video', order: 'relevance',
      q: 'DAX Analyse & Börse', maxResults: 25, pageToken: 'next/token+'
    }));

    assert.equal(request.origin, 'https://youtube.googleapis.com');
    assert.equal(request.pathname, '/youtube/v3/search');
    assert.deepEqual(Object.fromEntries(request.searchParams), {
      part: 'snippet',
      type: 'video',
      order: 'relevance',
      q: 'DAX Analyse & Börse',
      maxResults: '25',
      pageToken: 'next/token+',
      prettyPrint: 'false',
      key: 'key+with/&symbols'
    });
    assert.equal(request.searchParams.has('quotaUser'), false);
  } finally {
    if (previous === undefined) delete process.env.YOUTUBE_QUOTA_USER;
    else process.env.YOUTUBE_QUOTA_USER = previous;
  }
});
