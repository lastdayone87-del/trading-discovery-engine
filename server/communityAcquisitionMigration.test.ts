import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync} from 'node:fs';

test('community acquisition attempt history is additive, immutable, and separates operational outcomes',()=>{
  const sql=readFileSync('server/db/migrations/062_community_acquisition_attempts.sql','utf8');
  assert.match(sql,/CREATE TABLE IF NOT EXISTS discord_check_attempts/);
  assert.match(sql,/CREATE TABLE IF NOT EXISTS external_acquisition_observations/);
  assert.match(sql,/RATE_LIMITED/);assert.match(sql,/ACQUISITION_FAILED/);assert.match(sql,/PARTIALLY_INSPECTED/);
  assert.match(sql,/reject_immutable_event_mutation/);assert.doesNotMatch(sql,/\b(?:DROP|ALTER)\s+TABLE\b/i);
});
test('community reliability migration adds backward-compatible discovery projections',()=>{const sql=readFileSync('server/db/migrations/067_terminal_negative_and_community_retry.sql','utf8');assert.match(sql,/ADD COLUMN IF NOT EXISTS discord_discovery_status/);assert.match(sql,/DISCOVERED_VALIDATION_FAILED/);assert.match(sql,/ADD COLUMN IF NOT EXISTS discord_candidate_locator/);});

test('structured review reason migration preserves legacy values and adds governed metadata',()=>{const sql=readFileSync('server/db/migrations/068_discord_surfaces_and_review_reasons.sql','utf8');assert.match(sql,/reason_code TEXT NOT NULL DEFAULT 'LEGACY_FREE_TEXT'/);assert.match(sql,/reason_catalog_version TEXT NOT NULL DEFAULT 'legacy'/);assert.match(sql,/reason_other_text TEXT/);});
