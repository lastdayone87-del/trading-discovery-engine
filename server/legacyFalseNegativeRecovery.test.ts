import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import { getOperationalMaintenanceJobTypesForTests } from './operationalMaintenanceWorkers';

const migration=fs.readFileSync(new URL('./db/migrations/098_recover_conflict_policy_false_negatives.sql',import.meta.url),'utf8');
const discordSchema=fs.readFileSync(new URL('./db/migrations/069_discord_candidate_reliability.sql',import.meta.url),'utf8');
const maintenance=fs.readFileSync(new URL('./operationalMaintenanceWorkers.ts',import.meta.url),'utf8');

test('legacy machine false-negative recovery uses the governed dedicated worker',()=>{
  assert.ok(getOperationalMaintenanceJobTypesForTests().includes('CLASSIFICATION_FALSE_NEGATIVE_RESCAN'));
  assert.match(maintenance,/Reserve before claiming/);
  assert.match(maintenance,/reserveOfficialRecheckQuota\('OPERATIONAL_RECHECK'/);
  assert.match(maintenance,/claimNextJob\(workerId, \[FALSE_NEGATIVE_RECOVERY_JOB\]\)/);
  assert.match(maintenance,/triggerManualRecheck\(channelId, true, true\)/);
});

test('conflict-policy recovery is bounded and never reopens human or country rejection',()=>{
  assert.match(migration,/c\.trading_status='NON_TRADING'/);
  assert.match(migration,/c\.scan_status='SKIPPED_NON_TRADING'/);
  assert.match(migration,/c\.country_status<>'REJECTED'/);
  assert.match(migration,/channel_review_decisions[\s\S]*decision='REJECT'/);
  assert.match(migration,/channel_reviews[\s\S]*state='REJECTED'/);
  assert.match(migration,/LIMIT 100/);
  assert.match(migration,/classification-false-negative-recovery-v2:/);
});

test('recovery targets the pre-261 mixed-evidence contradiction shape',()=>{
  assert.match(migration,/HYPE_SPECULATION/);
  assert.match(migration,/NON_TRADING_ADJACENT/);
  assert.match(migration,/positive_weight > irrelevant_negative_weight/);
  assert.match(migration,/positive_count >= 2 AND positive_weight >= 20/);
  assert.match(migration,/2026-08-16 12:38:46\+00/);
});

test('upstream classifier skips persist Discord as not checked rather than Discord non-trading',()=>{
  assert.match(migration,/discord_status='UNCERTAIN'/);
  assert.match(migration,/discord_resolution_status='NOT_ATTEMPTED'/);
  assert.match(migration,/discord_liveness_status='NOT_CHECKED'/);
  assert.match(migration,/discord_relevance_status='NOT_CHECKED'/);
  assert.match(migration,/discord_validation_status='NOT_STARTED'/);
  assert.match(migration,/NEW\.discord_validation_status := 'NOT_STARTED'/);
  assert.doesNotMatch(migration,/discord_validation_status\s*(?:=|:=)\s*'NOT_ATTEMPTED'/);
  assert.match(migration,/CREATE TRIGGER channels_normalize_upstream_skipped_discord_state/);
  assert.match(migration,/BEFORE INSERT OR UPDATE/);
});

test('migration 098 only writes a validation status allowed by migration 069 schema',()=>{
  const validationConstraint=discordSchema.match(/discord_validation_status IN\(([^)]+)\)/)?.[1] ?? '';
  const allowed=new Set([...validationConstraint.matchAll(/'([^']+)'/g)].map(match=>match[1]));
  assert.ok(allowed.size>0,'expected migration 069 to define allowed validation statuses');
  const assigned=[...migration.matchAll(/discord_validation_status\s*(?::=|=)\s*'([^']+)'/g)].map(match=>match[1]);
  assert.ok(assigned.length>=2,'expected UPDATE and trigger assignments in migration 098');
  for(const status of assigned) assert.ok(allowed.has(status),`migration 098 writes unsupported discord_validation_status ${status}`);
});