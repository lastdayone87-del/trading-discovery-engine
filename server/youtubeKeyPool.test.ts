import assert from 'node:assert/strict';
import test from 'node:test';
import { getConfiguredYouTubeKeys, getConfiguredYouTubeProviders, getYouTubeQuotaGroupForKey, YOUTUBE_API_KEY_ENV_NAMES } from './youtubeKeyPool';

test('the YouTube provider pool reads every configured project in rotation order', () => {
  const environment = Object.fromEntries(YOUTUBE_API_KEY_ENV_NAMES.map((name, index) => [name, `project-${index + 1}`]));
  assert.deepEqual(getConfiguredYouTubeKeys(environment), Array.from({ length: 30 }, (_, index) => `project-${index + 1}`));
});

test('the YouTube provider pool still removes placeholders, blanks, and duplicate projects', () => {
  assert.deepEqual(getConfiguredYouTubeKeys({
    YOUTUBE_API_KEY: ' project-a ',
    YOUTUBE_API_KEY_1: 'MY_PLACEHOLDER',
    YOUTUBE_API_KEY_2: '',
    YOUTUBE_API_KEY_9: 'project-a'
  }), ['project-a']);
});

test('pool size is configuration-driven with a production default of thirty', () => {
  assert.equal(YOUTUBE_API_KEY_ENV_NAMES.length, 30);
  const environment = { YOUTUBE_API_KEY_POOL_SIZE: '32', YOUTUBE_API_KEY_31: 'project-32' };
  assert.deepEqual(getConfiguredYouTubeKeys(environment), ['project-32']);
  assert.throws(() => getConfiguredYouTubeKeys({ YOUTUBE_API_KEY_POOL_SIZE: '0' }), /positive integer/);
});

test('optional quota-group labels follow each key environment slot without exposing them through the key list', () => {
  const environment = {
    YOUTUBE_API_KEY_POOL_SIZE: '3',
    YOUTUBE_API_KEY: 'key-a',
    YOUTUBE_API_KEY_QUOTA_GROUP: 'google-project-1',
    YOUTUBE_API_KEY_1: 'key-b',
    YOUTUBE_API_KEY_1_QUOTA_GROUP: 'google-project-1',
    YOUTUBE_API_KEY_2: 'key-c',
    YOUTUBE_API_KEY_2_QUOTA_GROUP: 'google-project-2'
  };
  assert.deepEqual(getConfiguredYouTubeProviders(environment), [
    { key: 'key-a', envName: 'YOUTUBE_API_KEY', quotaGroup: 'google-project-1' },
    { key: 'key-b', envName: 'YOUTUBE_API_KEY_1', quotaGroup: 'google-project-1' },
    { key: 'key-c', envName: 'YOUTUBE_API_KEY_2', quotaGroup: 'google-project-2' }
  ]);
  assert.equal(getYouTubeQuotaGroupForKey('key-b', environment), 'google-project-1');
  assert.equal(getYouTubeQuotaGroupForKey('missing', environment), undefined);
  assert.deepEqual(getConfiguredYouTubeKeys(environment), ['key-a', 'key-b', 'key-c']);
});
