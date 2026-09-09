import test from 'node:test';
import assert from 'node:assert/strict';
import { rotateActiveProviderRow, applyDateOrderingProviderGuard } from './providerAwareRetrieval';
import { YOUTUBE_SEARCH_PROVIDER } from './providerAwareRetrieval';

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

test('mixed ACTIVE/CANARY registries never route untargeted traffic to canary', () => {
  const official = { provider_key: 'youtube-search', mode: 'ACTIVE' };
  const canary = { provider_key: 'youtube-innertube', mode: 'CANARY' };
  for (let i = 0; i < 50; i++) {
    assert.equal(
      rotateActiveProviderRow([official, canary], `opp-${i}`).provider_key,
      'youtube-search',
      'canary must not receive ordinary traffic while ACTIVE is eligible',
    );
  }
});

test('mixed ACTIVE/ACTIVE/CANARY registries rotate across active only', () => {
  const official = { provider_key: 'youtube-search', mode: 'ACTIVE' };
  const innertube = { provider_key: 'youtube-innertube', mode: 'ACTIVE' };
  const canary = { provider_key: 'brave-search', mode: 'CANARY' };
  const picks = new Set<string>();
  for (let i = 0; i < 50; i++) {
    picks.add(rotateActiveProviderRow([official, innertube, canary], `opp-${i}`).provider_key);
  }
  assert.ok(!picks.has('brave-search'), 'canary must be excluded while ACTIVE rows exist');
  assert.ok(picks.has('youtube-search') && picks.has('youtube-innertube'));
});

test('DATE ordering re-targets innertube runs to the official provider', () => {
  const innertube = {
    providerKey: 'youtube-innertube',
    retrievalSurface: 'YOUTUBE_NATIVE',
    capability: 'SEARCH_YOUTUBE',
    costDomain: 'YOUTUBE_INNERTUBE_FREE',
    continuationOwner: 'PHASE_9',
  } as const;
  const guarded = applyDateOrderingProviderGuard({ ...innertube }, 'DATE');
  assert.equal(guarded.switched, true);
  assert.equal(guarded.provider.providerKey, 'youtube-search');
  assert.equal(guarded.provider.costDomain, 'YOUTUBE_DATA_API');
});

test('RELEVANCE ordering never re-targets any provider', () => {
  const innertube = {
    providerKey: 'youtube-innertube',
    retrievalSurface: 'YOUTUBE_NATIVE',
    capability: 'SEARCH_YOUTUBE',
    costDomain: 'YOUTUBE_INNERTUBE_FREE',
    continuationOwner: 'PHASE_9',
  } as const;
  const kept = applyDateOrderingProviderGuard({ ...innertube }, 'RELEVANCE');
  assert.equal(kept.switched, false);
  assert.equal(kept.provider.providerKey, 'youtube-innertube');
  const official = applyDateOrderingProviderGuard({ ...YOUTUBE_SEARCH_PROVIDER }, 'DATE');
  assert.equal(official.switched, false);
  assert.equal(official.provider.providerKey, 'youtube-search');
});
