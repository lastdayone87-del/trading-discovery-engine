import assert from 'node:assert/strict';
import test from 'node:test';
import { getConfiguredYouTubeKeys, YOUTUBE_API_KEY_ENV_NAMES } from './youtubeKeyPool';

test('the YouTube provider pool reads all ten configured projects in rotation order', () => {
  const environment = Object.fromEntries(YOUTUBE_API_KEY_ENV_NAMES.map((name, index) => [name, `project-${index + 1}`]));
  assert.deepEqual(getConfiguredYouTubeKeys(environment), Array.from({ length: 10 }, (_, index) => `project-${index + 1}`));
});

test('the YouTube provider pool still removes placeholders, blanks, and duplicate projects', () => {
  assert.deepEqual(getConfiguredYouTubeKeys({
    YOUTUBE_API_KEY: ' project-a ',
    YOUTUBE_API_KEY_1: 'MY_PLACEHOLDER',
    YOUTUBE_API_KEY_2: '',
    YOUTUBE_API_KEY_9: 'project-a'
  }), ['project-a']);
});
