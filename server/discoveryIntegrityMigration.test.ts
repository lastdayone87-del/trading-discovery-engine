/**
 * Migration 149 + persistence text contracts.
 *
 * Migration 149 is the schema change behind the discovery-integrity fixes:
 * site-inspection claim handshake columns, channel community-intent state, and
 * the explicit recovery audit table. These assertions are intentionally
 * textual: they pin the exact additive shape so a later edit cannot silently
 * turn the migration destructive or rename a column the code depends on.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const migrationsDir = fileURLToPath(new URL('./db/migrations/', import.meta.url));
const migration = readFileSync(`${migrationsDir}149_discovery_integrity_state.sql`, 'utf8');
const dbCore = readFileSync(fileURLToPath(new URL('./dbCore.ts', import.meta.url)), 'utf8');
const siteCache = readFileSync(fileURLToPath(new URL('./siteInspectionCache.ts', import.meta.url)), 'utf8');

test('migration 149 is present and sorts after every earlier migration', () => {
  const files = readdirSync(migrationsDir).filter(name => name.endsWith('.sql')).sort();
  assert.ok(files.includes('149_discovery_integrity_state.sql'));
  assert.equal(files[files.length - 1], '149_discovery_integrity_state.sql', '149 is the newest migration');
});

test('migration 149 is additive-only (no drops, deletes, or rewrites)', () => {
  const statements = migration.replace(/COMMENT ON[^;]+;/g, '').split(';').map(part => part.trim()).filter(Boolean);
  assert.ok(statements.length > 0);
  for (const statement of statements) {
    assert.doesNotMatch(statement, /^\s*DROP\b/i, `destructive statement: ${statement.slice(0, 80)}`);
    assert.doesNotMatch(statement, /^\s*DELETE\b/i, `destructive statement: ${statement.slice(0, 80)}`);
    assert.doesNotMatch(statement, /^\s*UPDATE\b/i, `destructive statement: ${statement.slice(0, 80)}`);
    assert.doesNotMatch(statement, /^\s*TRUNCATE\b/i, `destructive statement: ${statement.slice(0, 80)}`);
  }
  assert.match(migration, /ALTER TABLE site_inspections ADD COLUMN IF NOT EXISTS source_channel_id TEXT;/);
  assert.match(migration, /ALTER TABLE site_inspections ADD COLUMN IF NOT EXISTS claim_status TEXT NOT NULL DEFAULT 'NONE';/);
  assert.match(migration, /ALTER TABLE channels ADD COLUMN IF NOT EXISTS community_discovery_status TEXT NOT NULL DEFAULT 'NONE';/);
  assert.match(migration, /ALTER TABLE channels ADD COLUMN IF NOT EXISTS community_intents JSONB NOT NULL DEFAULT '\[\]'::jsonb;/);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS discovery_recovery_audit/);
});

test('claim-status constraint matches the runtime handshake states', () => {
  for (const status of ['NONE', 'PENDING', 'CLAIMED', 'DISCARDED']) {
    assert.ok(migration.includes(`'${status}'`), `migration names ${status}`);
    assert.ok(siteCache.includes(`${status}: '${status}'`), `runtime names ${status}`);
  }
  assert.match(migration, /CHECK \(claim_status IN \('NONE','PENDING','CLAIMED','DISCARDED'\)\)/);
});

test('community discovery status is constrained to the three real states', () => {
  assert.match(
    migration,
    /CHECK \(community_discovery_status IN \('NONE','COMMUNITY_INDICATED_NO_INVITE','PAID_COMMUNITY_INDICATED'\)\)/,
  );
  assert.match(migration, /CHECK \(jsonb_typeof\(community_intents\) = 'array'\)/);
});

test('recovery audit table records source, channel, candidate ids, and counts', () => {
  assert.match(migration, /source TEXT NOT NULL CHECK \(source IN \('CACHE','HISTORICAL'\)\)/);
  assert.match(migration, /candidate_ids JSONB NOT NULL DEFAULT '\[\]'::jsonb CHECK \(jsonb_typeof\(candidate_ids\) = 'array'\)/);
  assert.match(migration, /candidate_count INTEGER NOT NULL DEFAULT 0 CHECK \(candidate_count >= 0\)/);
  assert.match(migration, /CREATE INDEX IF NOT EXISTS idx_discovery_recovery_audit_channel/);
});

test('dbCore writes and reads the same claim/community column names', () => {
  assert.match(dbCore, /INSERT INTO site_inspections\(site_identity,identity_tier,identity_basis,canonical_url,final_url,outcome,retryable,http_status,failure_class,detail,payload_checksum,candidates,observations,rendered_covered,source_channel_id,claim_status,provenance,/);
  assert.match(dbCore, /UPDATE site_inspections SET claim_status='CLAIMED' WHERE source_channel_id=\$1 AND claim_status='PENDING'/);
  assert.match(dbCore, /sourceChannelId: typeof item\.source_channel_id === 'string' \? item\.source_channel_id : null,/);
  assert.match(dbCore, /claimStatus: text\(item\.claim_status\),/);
});

test('claim handshake only flips PENDING rows for the recording channel', () => {
  // A CLAIMED/DISCARDED row is terminal; an unclaimed (NONE) row is never
  // promoted, because NONE with candidates must keep forcing a recrawl.
  assert.match(siteCache, /export const SITE_INSPECTION_CLAIM_STATUS = \{/);
  assert.match(dbCore, /WHERE source_channel_id=\$1 AND claim_status='PENDING'/);
  assert.match(siteCache, /if \(row\.claimStatus !== SITE_INSPECTION_CLAIM_STATUS\.CLAIMED && row\.claimStatus !== SITE_INSPECTION_CLAIM_STATUS\.DISCARDED\) return false;/);
});
