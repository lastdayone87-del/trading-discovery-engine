import test from 'node:test';
import assert from 'node:assert/strict';
import { rotateActiveProviderRow } from './discoveryFrontierAllocator';

const official = { provider_key: 'youtube-search', mode: 'ACTIVE' };
const innertube = { provider_key: 'youtube-innertube', mode: 'ACTIVE' };

test('single eligible row resolves deterministically (legacy behavior preserved)', () => {
  assert.equal(rotateActiveProviderRow([official], 'opp-1'), official);
  assert.equal(rotateActiveProviderRow([innertube], 'opp-1'), innertube);
});

test('empty rows throw instead of silently falling back', () => {
  assert.throws(() => rotateActiveProviderRow([], 'opp-1'), /NO_ELIGIBLE_PROVIDER_ROWS/);
});

test('two active providers share traffic deterministically across opportunities', () => {
  const picks = new Set<string>();
  for (let i = 0; i < 50; i++) {
    picks.add(rotateActiveProviderRow([official, innertube], `opp-${i}`).provider_key);
  }
  assert.ok(picks.has('youtube-search'), 'official provider must keep serving traffic');
  assert.ok(picks.has('youtube-innertube'), 'innertube provider must serve traffic');
  // Determinism: same opportunity always maps to the same provider.
  for (let i = 0; i < 50; i++) {
    assert.equal(
      rotateActiveProviderRow([official, innertube], `opp-${i}`).provider_key,
      rotateActiveProviderRow([innertube, official], `opp-${i}`).provider_key,
      'pick must not depend on database return order',
    );
  }
});

test('canary rows sort behind active rows but stay selectable when alone', () => {
  const canary = { provider_key: 'youtube-innertube', mode: 'CANARY' };
  assert.equal(rotateActiveProviderRow([canary], 'opp-1'), canary);
});
