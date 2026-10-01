import assert from 'node:assert/strict';
import test from 'node:test';
import { buildDepth2Proposals, evaluateDepth2Eligibility } from './graphExpansionPolicy';

const PARENT = 'UCJdBRGdAz-Or0MwCQoS072Q';

test('depth-2 denies without canary enablement', () => {
  const r = evaluateDepth2Eligibility({ parentDepth: 1, fanoutRequested: 5, edgeKind: 'FEATURED', independentFamilies: 2, canaryEnabled: false });
  assert.equal(r.eligible, false);
  assert.equal(r.reasonCode, 'GRAPH_CANARY_NOT_ENABLED');
});

test('depth-2 enforces depth, independence, and saturation guards', () => {
  assert.equal(evaluateDepth2Eligibility({ parentDepth: 2, fanoutRequested: 5, edgeKind: 'FEATURED', independentFamilies: 2, canaryEnabled: true }).reasonCode, 'GRAPH_DEPTH_EXCEEDED');
  assert.equal(evaluateDepth2Eligibility({ parentDepth: 1, fanoutRequested: 5, edgeKind: 'PLAYLIST_COHOST', independentFamilies: 1, canaryEnabled: true }).reasonCode, 'GRAPH_INSUFFICIENT_INDEPENDENCE');
  assert.equal(
    evaluateDepth2Eligibility({ parentDepth: 1, fanoutRequested: 5, edgeKind: 'URL_COMENTION', independentFamilies: 2, overlap: 0.9, knownFraction: 0.9, canaryEnabled: true }).reasonCode,
    'GRAPH_NEIGHBORHOOD_SATURATED',
  );
});

test('depth-2 caps fanout and builds deterministic provenance', () => {
  const e = evaluateDepth2Eligibility({ parentDepth: 1, fanoutRequested: 50, edgeKind: 'GUEST_MENTION', independentFamilies: 3, canaryEnabled: true });
  assert.equal(e.eligible, true);
  assert.equal(e.cappedFanout, 10);
  const proposals = buildDepth2Proposals(PARENT, 'GUEST_MENTION', 50, e);
  assert.equal(proposals.length, 10);
  assert.ok(proposals[0].provenance.startsWith(`depth2:${PARENT}:GUEST_MENTION:`));
  assert.throws(() => buildDepth2Proposals(PARENT, 'FEATURED', 5, { ...e, eligible: false, reasonCode: 'X' }), /NOT_ELIGIBLE/);
  assert.throws(() => buildDepth2Proposals('bad', 'FEATURED', 5, e), /INVALID_PARENT/);
});

test('depth-2 rejects non-finite numeric inputs as fail-closed', () => {
  const base = { parentDepth: 1, fanoutRequested: 5, edgeKind: 'FEATURED' as const, independentFamilies: 2, canaryEnabled: true };
  for (const bad of [
    { ...base, parentDepth: NaN },
    { ...base, independentFamilies: NaN },
    { ...base, overlap: NaN },
    { ...base, knownFraction: Infinity },
    { ...base, parentDepth: Infinity },
  ]) {
    const r = evaluateDepth2Eligibility(bad);
    assert.equal(r.eligible, false);
    assert.equal(r.reasonCode, 'GRAPH_INVALID_NUMERIC_INPUT');
  }
});

test('depth-2 neighbor binding distinguishes candidate lineages deterministically', () => {
  const e = evaluateDepth2Eligibility({ parentDepth: 1, fanoutRequested: 3, edgeKind: 'FEATURED', independentFamilies: 2, canaryEnabled: true });
  const neighbor = 'UCZH9XjihGZGczInZMuXMlfw';
  const a = buildDepth2Proposals(PARENT, 'FEATURED', 3, e, { neighborChannelId: neighbor, neighborLineage: 'playlist:PLabc' });
  const b = buildDepth2Proposals(PARENT, 'FEATURED', 3, e, { neighborChannelId: neighbor, neighborLineage: 'playlist:PLxyz' });
  const unbound = buildDepth2Proposals(PARENT, 'FEATURED', 3, e);
  // One binding describes one candidate: exactly one bound proposal, never fanout copies.
  assert.equal(a.length, 1);
  assert.equal(unbound.length, 3);
  assert.notEqual(a[0].proposalKey, b[0].proposalKey);
  assert.notEqual(a[0].proposalKey, unbound[0].proposalKey);
  assert.deepEqual(buildDepth2Proposals(PARENT, 'FEATURED', 3, e, { neighborChannelId: neighbor, neighborLineage: 'playlist:PLabc' })[0], a[0]);
  assert.ok(a[0].provenance.includes(neighbor));
  assert.throws(() => buildDepth2Proposals(PARENT, 'FEATURED', 3, e, { neighborChannelId: 'bad', neighborLineage: 'x' }), /INVALID_NEIGHBOR/);
  assert.throws(() => buildDepth2Proposals(PARENT, 'FEATURED', 3, e, { neighborChannelId: neighbor, neighborLineage: '  ' }), /INVALID_NEIGHBOR/);
});
