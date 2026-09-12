import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveBuildInfo } from './buildInfo';

test('commit SHA resolves from platform variables in priority order', () => {
  assert.deepEqual(
    resolveBuildInfo({ RAILWAY_GIT_COMMIT_SHA: '714909a', GIT_COMMIT: 'aaaaaaa' }, () => '2026-09-12T00:00:00.000Z'),
    {
      commitSha: '714909a',
      commitSource: 'RAILWAY_GIT_COMMIT_SHA',
      buildTime: '2026-09-12T00:00:00.000Z',
      buildTimeSource: 'startup',
    },
  );
  assert.equal(
    resolveBuildInfo({ GIT_COMMIT: 'ABCDEF123456' }, () => '2026-09-12T00:00:00.000Z').commitSha,
    'abcdef123456',
  );
  assert.equal(
    resolveBuildInfo({ SOURCE_VERSION: 'deadbee' }, () => '2026-09-12T00:00:00.000Z').commitSource,
    'SOURCE_VERSION',
  );
});

test('missing or malformed provenance is reported as unknown, never fabricated', () => {
  const missing = resolveBuildInfo({}, () => '2026-09-12T00:00:00.000Z');
  assert.equal(missing.commitSha, 'unknown');
  assert.equal(missing.commitSource, 'unknown');
  const malformed = resolveBuildInfo(
    { GIT_COMMIT: 'not-a-sha!!', BUILD_TIME: 'yesterday' },
    () => '2026-09-12T00:00:00.000Z',
  );
  assert.equal(malformed.commitSha, 'unknown');
  assert.equal(malformed.buildTime, '2026-09-12T00:00:00.000Z');
  assert.equal(malformed.buildTimeSource, 'startup');
});

test('explicit BUILD_TIME is honored when valid', () => {
  const info = resolveBuildInfo({ BUILD_TIME: '2026-09-01T10:00:00Z' }, () => '2026-09-12T00:00:00.000Z');
  assert.equal(info.buildTime, '2026-09-01T10:00:00.000Z');
  assert.equal(info.buildTimeSource, 'BUILD_TIME');
});
