import assert from 'node:assert/strict';
import test from 'node:test';
import { buildYouTubeApiUrl } from './youtube';

test('buildYouTubeApiUrl constructs a canonical and fully encoded request', () => {
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
      quotaUser: 'railway discovery/production',
      prettyPrint: 'false',
      key: 'key+with/&symbols'
    });
  } finally {
    if (previous === undefined) delete process.env.YOUTUBE_QUOTA_USER;
    else process.env.YOUTUBE_QUOTA_USER = previous;
  }
});

test('buildYouTubeApiUrl applies a non-empty, 40-character quotaUser bound', () => {
  const previous = process.env.YOUTUBE_QUOTA_USER;
  process.env.YOUTUBE_QUOTA_USER = ' '.repeat(3) + 'x'.repeat(50);
  try {
    const request = new URL(buildYouTubeApiUrl('videos', 'api-key', { part: 'snippet', id: 'a,b' }));
    assert.equal(request.searchParams.get('quotaUser'), 'x'.repeat(40));
  } finally {
    if (previous === undefined) delete process.env.YOUTUBE_QUOTA_USER;
    else process.env.YOUTUBE_QUOTA_USER = previous;
  }
});
