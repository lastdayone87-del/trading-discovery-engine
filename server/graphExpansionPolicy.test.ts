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
