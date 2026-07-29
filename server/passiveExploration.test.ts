import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { normalizeActionTarget, semanticActionKey } from './passiveExploration';

test('semantic action keys are deterministic and distinguish pages and runs',()=>{
  const a={queryRunId:'00000000-0000-0000-0000-000000000001',query:'  Price\u00a0 Action   Trading ',pageNumber:1};
  assert.equal(normalizeActionTarget(a.query),'price action trading');
  assert.equal(semanticActionKey(a),semanticActionKey({...a,query:'price action trading'}));
  assert.notEqual(semanticActionKey(a),semanticActionKey({...a,pageNumber:2}));
  assert.notEqual(semanticActionKey(a),semanticActionKey({...a,queryRunId:'00000000-0000-0000-0000-000000000002'}));
});

test('passive module exposes no claim, activation, or execution primitive',async()=>{
  const module=await import('./passiveExploration');
  assert.deepEqual(Object.keys(module).sort(),['PASSIVE_EXPLORATION_POLICY_VERSION','inspectPassivePrograms','normalizeActionTarget','recordPassivePage','recordShadowFailure','semanticActionKey']);
});

test('migration is expand-only, indexed, immutable, and hard-disables activation',()=>{
  const sql=readFileSync(new URL('./db/migrations/020_passive_exploration_control_plane.sql',import.meta.url),'utf8');
  assert.doesNotMatch(sql,/\b(?:DROP TABLE|DROP COLUMN|TRUNCATE)\b/i);
  assert.match(sql,/activation_enabled BOOLEAN NOT NULL DEFAULT false CHECK \(activation_enabled = false\)/);
  assert.match(sql,/frontier_action_outcomes_immutable/);
  assert.match(sql,/idx_frontier_actions_source/);
  assert.match(sql,/lifecycle IN \('ACTIVE','SLEEPING','SATURATED','PAUSED','COMPLETE'\)/);
});
