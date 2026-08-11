import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const rolloutSource = () => readFile(new URL('./rollout.ts', import.meta.url), 'utf8');
const reviewPolicySource = () => readFile(new URL('../reviewEligibility/policy.ts', import.meta.url), 'utf8');

test('review eligibility remains a separately governed Release-5 capability', async () => {
  const source = await rolloutSource();
  assert.match(source, /'REVIEW_ELIGIBILITY'/);
  assert.match(source, /release5_review_serving_mode/);
  assert.match(source, /expected=input\.capability==='DASHBOARD_CORPUS'\?'dashboard-corpus':input\.capability==='REVIEW_ELIGIBILITY'\?'review-eligibility'/);
});

test('review serving remains fail-closed while its kill switch is OFF', async () => {
  const source = await rolloutSource();
  assert.match(source, /setting=await getAppSetting\(settingKey,'OFF'\)/);
  assert.match(source, /if\(setting==='OFF'\)return \{assigned:false,mode:'OFF'\}/);
});

test('review canary assignment requires a promoted matching rollout', async () => {
  const source = await rolloutSource();
  assert.match(source, /gate\.rows\[0\]\.decision!=='PROMOTE'/);
  assert.match(source, /PROMOTION_GATE_CAPABILITY_MISMATCH/);
  assert.match(source, /projection\.rows\[0\]\.gate_decision!=='PROMOTE'/);
});

test('review policy is shadow-only and requires a plausible trading hypothesis', async () => {
  const source = await reviewPolicySource();
  assert.match(source, /servingAuthority:false/);
  assert.match(source, /PLAUSIBLE_TRADING_HYPOTHESIS_REQUIRED/);
  assert.match(source, /EVIDENCE_ACQUISITION_REQUIRED/);
  assert.match(source, /AMBIGUITY_REQUIRES_HUMAN_JUDGMENT/);
});

test('terminal classifications cannot be rematerialized into review', async () => {
  const source = await reviewPolicySource();
  assert.match(source, /TERMINAL_DECISION_NOT_REVIEWABLE/);
  assert.match(source, /TRADING_CONFIRMED','NON_TRADING','HUMAN_REJECTED/);
});
