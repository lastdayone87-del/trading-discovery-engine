import assert from 'node:assert/strict';
import test from 'node:test';
import {
  getConfiguredYouTubeKeys,
  getConfiguredYouTubeProviders,
  getYouTubeApiKeyEnvNames,
  getYouTubeApiKeyPoolSize,
  getYouTubeQuotaGroupForKey,
  YOUTUBE_API_KEY_ENV_NAMES
} from './youtubeKeyPool';

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

test('the default declared pool remains thirty slots for backwards compatibility', () => {
  assert.equal(YOUTUBE_API_KEY_ENV_NAMES.length, 30);
  assert.equal(getYouTubeApiKeyPoolSize({}), 30);
  assert.deepEqual(getYouTubeApiKeyEnvNames({}).slice(-2), ['YOUTUBE_API_KEY_28', 'YOUTUBE_API_KEY_29']);
});

test('explicit pool size remains supported as a minimum declared range', () => {
  const environment = { YOUTUBE_API_KEY_POOL_SIZE: '32', YOUTUBE_API_KEY_31: 'project-32' };
  assert.equal(getYouTubeApiKeyPoolSize(environment), 32);
  assert.deepEqual(getConfiguredYouTubeKeys(environment), ['project-32']);
  assert.throws(() => getConfiguredYouTubeKeys({ YOUTUBE_API_KEY_POOL_SIZE: '0' }), /positive integer/);
});

test('additional indexed keys are discovered automatically without changing pool size configuration', () => {
  const environment = {
    YOUTUBE_API_KEY: 'base-key',
    YOUTUBE_API_KEY_30: 'key-30',
    YOUTUBE_API_KEY_47: 'key-47',
    YOUTUBE_API_KEY_125: 'key-125'
  };

  assert.equal(getYouTubeApiKeyPoolSize(environment), 33);
  assert.deepEqual(getConfiguredYouTubeProviders(environment), [
    { key: 'base-key', envName: 'YOUTUBE_API_KEY' },
    { key: 'key-30', envName: 'YOUTUBE_API_KEY_30' },
    { key: 'key-47', envName: 'YOUTUBE_API_KEY_47' },
    { key: 'key-125', envName: 'YOUTUBE_API_KEY_125' }
  ]);
});

test('runtime discovery is numerically ordered and ignores non-canonical key-like variables', () => {
  const environment = {
    YOUTUBE_API_KEY_POOL_SIZE: '1',
    YOUTUBE_API_KEY: 'base',
    YOUTUBE_API_KEY_100: 'hundred',
    YOUTUBE_API_KEY_2: 'two',
    YOUTUBE_API_KEY_31: 'thirty-one',
    YOUTUBE_API_KEY_0: 'non-canonical-zero',
    YOUTUBE_API_KEY_BACKUP: 'backup',
    YOUTUBE_API_KEY_ABC: 'abc',
    YOUTUBE_API_KEY_999_QUOTA_GROUP: 'label-only'
  };

  assert.deepEqual(getYouTubeApiKeyEnvNames(environment), [
    'YOUTUBE_API_KEY',
    'YOUTUBE_API_KEY_2',
    'YOUTUBE_API_KEY_31',
    'YOUTUBE_API_KEY_100'
  ]);
  assert.deepEqual(getConfiguredYouTubeKeys(environment), ['base', 'two', 'thirty-one', 'hundred']);
});

test('a configured key beyond the declared range cannot be hidden by a smaller pool size', () => {
  const environment = {
    YOUTUBE_API_KEY_POOL_SIZE: '2',
    YOUTUBE_API_KEY_1: 'declared',
    YOUTUBE_API_KEY_80: 'auto-discovered'
  };
  assert.deepEqual(getConfiguredYouTubeKeys(environment), ['declared', 'auto-discovered']);
  assert.equal(getYouTubeApiKeyPoolSize(environment), 3);
});

test('optional quota-group labels follow each key environment slot without exposing them through the key list', () => {
  const environment = {
    YOUTUBE_API_KEY_POOL_SIZE: '3',
    YOUTUBE_API_KEY: 'key-a',
    YOUTUBE_API_KEY_QUOTA_GROUP: 'google-project-1',
    YOUTUBE_API_KEY_1: 'key-b',
    YOUTUBE_API_KEY_1_QUOTA_GROUP: 'google-project-1',
    YOUTUBE_API_KEY_2: 'key-c',
    YOUTUBE_API_KEY_2_QUOTA_GROUP: 'google-project-2',
    YOUTUBE_API_KEY_45: 'key-d',
    YOUTUBE_API_KEY_45_QUOTA_GROUP: 'google-project-3'
  };
  assert.deepEqual(getConfiguredYouTubeProviders(environment), [
    { key: 'key-a', envName: 'YOUTUBE_API_KEY', quotaGroup: 'google-project-1' },
    { key: 'key-b', envName: 'YOUTUBE_API_KEY_1', quotaGroup: 'google-project-1' },
    { key: 'key-c', envName: 'YOUTUBE_API_KEY_2', quotaGroup: 'google-project-2' },
    { key: 'key-d', envName: 'YOUTUBE_API_KEY_45', quotaGroup: 'google-project-3' }
  ]);
  assert.equal(getYouTubeQuotaGroupForKey('key-b', environment), 'google-project-1');
  assert.equal(getYouTubeQuotaGroupForKey('key-d', environment), 'google-project-3');
  assert.equal(getYouTubeQuotaGroupForKey('missing', environment), undefined);
  assert.deepEqual(getConfiguredYouTubeKeys(environment), ['key-a', 'key-b', 'key-c', 'key-d']);
});
