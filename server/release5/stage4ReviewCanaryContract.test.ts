import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const rolloutSource = () => readFile(new URL('./rollout.ts', import.meta.url), 'utf8');
const reviewPolicySource = () => readFile(new URL('../reviewEligibility/policy.ts', import.meta.url), 'utf8');

test('legacy Release-5 review rollout remains available as a compatibility control', async () => {
  const source = await rolloutSource();
  assert.match(source, /'REVIEW_ELIGIBILITY'/);
  assert.match(source, /release5_review_serving_mode/);
});

test('legacy review canary remains fail-closed while its kill switch is OFF', async () => {
  const source = await rolloutSource();
  assert.match(source, /setting=await getAppSetting\(settingKey,'OFF'\)/);
  assert.match(source, /if\(setting==='OFF'\)return \{assigned:false,mode:'OFF'\}/);
});

test('legacy review canary assignment still requires a promoted matching rollout', async () => {
  const source = await rolloutSource();
  assert.match(source, /gate\.rows\[0\]\.decision!=='PROMOTE'/);
  assert.match(source, /PROMOTION_GATE_CAPABILITY_MISMATCH/);
});

test('review policy is serving-authoritative and requires evidence-complete plausible ambiguity', async () => {
  const source = await reviewPolicySource();
  assert.match(source, /servingAuthority:true/);
  assert.match(source, /PLAUSIBLE_TRADING_HYPOTHESIS_REQUIRED/);
  assert.match(source, /EVIDENCE_ACQUISITION_REQUIRED/);
  assert.match(source, /PROVIDER_RECOVERY_REQUIRED/);
  assert.match(source, /LANGUAGE_CAPABILITY_REQUIRED/);
  assert.match(source, /AMBIGUITY_REQUIRES_HUMAN_JUDGMENT/);
});

test('terminal classifications cannot be rematerialized into review', async () => {
  const source = await reviewPolicySource();
  assert.match(source, /TERMINAL_DECISION_NOT_REVIEWABLE/);
  assert.match(source, /TRADING_CONFIRMED','NON_TRADING','HUMAN_REJECTED/);
});
