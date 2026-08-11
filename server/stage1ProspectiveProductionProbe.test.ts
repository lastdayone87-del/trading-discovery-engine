import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const source = readFileSync(new URL('../scripts/runStage1ProspectiveProductionProbe.ts', import.meta.url), 'utf8');

test('probe requires explicit operator confirmation and selects only a fresh channel', () => {
  assert.match(source, /RUN_STAGE1_PROSPECTIVE_PRODUCTION_PROBE/);
  assert.match(source, /if \(!await getChannelById\(raw\.channelId\)\)/);
  assert.match(source, /NO_FRESH_PRODUCTION_PROBE_CANDIDATE/);
  assert.match(source, /exactlyOneSelectedCandidate: true/);
});

test('probe preserves retrieval-before-classification ordering on the real production entrypoints', () => {
  const nomination = source.indexOf('await recordNomination');
  const pipeline = source.indexOf('await processDiscoveredChannel');
  assert.ok(nomination >= 0, 'probe must use recordNomination');
  assert.ok(pipeline > nomination, 'prospective nomination must precede production classification');
  assert.match(source, /sourceType: 'automated_query'/);
  assert.match(source, /processDiscoveredChannel\(candidate, country, 'automated_query'\)/);
});

test('probe does not weaken Stage 1 authority and only reports readiness after complete current lineage', () => {
  assert.match(source, /policy_key=\$2/);
  assert.match(source, /d\.created_at>=a\.assigned_at/);
  assert.match(source, /creator_focus_classification_snapshots/);
  assert.match(source, /evidence_coverage_snapshots/);
  assert.match(source, /!lineage\?\.independent_label_id/);
  assert.match(source, /servingAuthorityGrantedByProbe: false/);
  assert.match(source, /stage1AuthorityChanged: false/);
  assert.doesNotMatch(source, /activateRelease5Capability|setRelease5KillSwitch|persistPromotionGate/);
});
