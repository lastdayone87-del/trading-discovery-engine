import assert from 'node:assert/strict';
import test from 'node:test';
import { parseBenchmarkArgs, resolveCliSpecVersion } from './benchmarkPreregCli';

test('documented v1/v2 aliases resolve to full spec versions', () => {
  assert.equal(resolveCliSpecVersion('v1'), 'benchmark-preregistration-v1');
  assert.equal(resolveCliSpecVersion('v2'), 'benchmark-preregistration-v2');
  assert.equal(
    parseBenchmarkArgs(['--execute', '--spec-version=v2', '--out', 'x']).specVersion,
    'benchmark-preregistration-v2'
  );
  assert.equal(
    parseBenchmarkArgs(['--execute', '--spec-version=v1', '--out', 'x']).specVersion,
    'benchmark-preregistration-v1'
  );
});

test('full spec strings pass through and unknown flags fail closed', () => {
  assert.equal(
    parseBenchmarkArgs(['--plan', '--spec-version=benchmark-preregistration-v2', '--out', 'x']).specVersion,
    'benchmark-preregistration-v2'
  );
  const def = parseBenchmarkArgs(['--plan', '--out', 'x']);
  assert.equal(def.specVersion, 'benchmark-preregistration-v1');
  assert.equal(def.mode, 'plan');
  assert.throws(() => parseBenchmarkArgs(['--plan']), /Missing required --out/);
  assert.throws(() => parseBenchmarkArgs(['--plan', '--out', 'x', '--bogus']), /Unknown flag/);
});
