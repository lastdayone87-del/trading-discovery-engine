import assert from 'node:assert/strict';
import test from 'node:test';
import {
  earliestYouTubeProjectRetryAt,
  isYouTubeProjectSuspended,
  resetYouTubeProjectSuspensionsForTests,
  suspendYouTubeProject,
} from './youtubeProjectSuspension';

test('project suspension excludes every key until its retry date', () => {
  resetYouTubeProjectSuspensionsForTests();
  const now = 1_000_000;
  suspendYouTubeProject('project-a', now + 60_000, now);
  assert.equal(isYouTubeProjectSuspended('project-a', now), true);
  assert.equal(isYouTubeProjectSuspended('project-a', now + 60_001), false);
  assert.equal(isYouTubeProjectSuspended('project-b', now), false);
  assert.equal(isYouTubeProjectSuspended(null, now), false);
});

test('earliest project retry is reported for a fully suspended key set', () => {
  resetYouTubeProjectSuspensionsForTests();
  const now = 1_000_000;
  suspendYouTubeProject('project-a', now + 60_000, now);
  suspendYouTubeProject('project-b', now + 120_000, now);
  assert.equal(earliestYouTubeProjectRetryAt(['project-a', 'project-b'], now), now + 60_000);
  assert.equal(earliestYouTubeProjectRetryAt(['project-c'], now), null);
});

test('project suspension never shortens an existing later horizon', () => {
  resetYouTubeProjectSuspensionsForTests();
  const now = 1_000_000;
  suspendYouTubeProject('project-a', now + 120_000, now);
  suspendYouTubeProject('project-a', now + 30_000, now);
  assert.equal(isYouTubeProjectSuspended('project-a', now + 60_000), true);
  assert.equal(isYouTubeProjectSuspended('project-a', now + 120_001), false);
});
