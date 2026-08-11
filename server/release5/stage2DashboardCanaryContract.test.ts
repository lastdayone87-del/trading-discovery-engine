import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const dbSource = () => readFile(new URL('../db.ts', import.meta.url), 'utf8');
const rolloutSource = () => readFile(new URL('./rollout.ts', import.meta.url), 'utf8');

test('dashboard serving stays on the legacy operator-visible predicate while the kill switch is OFF', async () => {
  const source = await dbSource();
  assert.match(source, /release5_dashboard_serving_mode/);
  assert.match(source, /setting_value==='OFF'/);
  assert.match(source, /predicate:OPERATOR_VISIBLE_CHANNEL_SQL/);
});

test('dashboard canary routes assigned treatment through CONFIRMED or REVIEW projection only', async () => {
  const source = await dbSource();
  assert.match(source, /dcp\.corpus IN\('CONFIRMED','REVIEW'\)/);
  assert.match(source, /rsa\.capability='DASHBOARD_CORPUS'/);
  assert.match(source, /rsa\.assigned=true/);
  assert.match(source, /RELEASE5_CANARY_DASHBOARD_CORPUS/);
});

test('unassigned canary subjects retain the exact legacy listing predicate', async () => {
  const source = await dbSource();
  assert.match(source, /NOT \(\$\{assigned\}\) AND \(\$\{OPERATOR_VISIBLE_CHANNEL_SQL\}\)/);
});

test('ACTIVE dashboard mode does not silently fall back when a projection is missing', async () => {
  const source = await dbSource();
  assert.match(source, /mode==='ACTIVE'.*predicate:projected/s);
  assert.match(source, /RELEASE5_ACTIVE_DASHBOARD_CORPUS/);
});

test('release 5 serving requires both explicit control and a PROMOTE gate', async () => {
  const source = await rolloutSource();
  assert.match(source, /setting==='OFF'.*assigned:false/s);
  assert.match(source, /gate_decision!=='PROMOTE'/);
  assert.match(source, /APPROVED_MATCHING_ACTIVATION_REQUIRED/);
});
