/**
 * Migration 149/150/151 + persistence text contracts.
 *
 * Migration 149 is the schema change behind the discovery-integrity fixes:
 * site-inspection claim handshake columns, channel community-intent state, and
 * the explicit recovery audit table. Migration 150 adds the per-channel
 * pending-candidate map so a second writer cannot erase an unclaimed invite.
 * Migration 151 adds the inert shadow-cap settlement fence so a late
 * observation cannot recreate a lease or a false cap event.
 * Migration 152 adds the nullable Discord first-validation timestamp and
 * backfills it only from successful append-only check attempts.
 * These assertions are intentionally textual: they pin the exact additive
 * shape so a later edit cannot silently turn the migration destructive or
 * rename a column the code depends on.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const migrationsDir = fileURLToPath(new URL('./db/migrations/', import.meta.url));
const migration = readFileSync(`${migrationsDir}149_discovery_integrity_state.sql`, 'utf8');
const pendingClaimsMigration = readFileSync(`${migrationsDir}150_site_inspection_pending_claims.sql`, 'utf8');
const shadowSettlementMigration = readFileSync(`${migrationsDir}151_youtube_key_cap_shadow_settled.sql`, 'utf8');
const firstValidatedMigration = readFileSync(`${migrationsDir}152_discord_candidate_first_validated.sql`, 'utf8');
const dbCore = readFileSync(fileURLToPath(new URL('./dbCore.ts', import.meta.url)), 'utf8');
const siteCache = readFileSync(fileURLToPath(new URL('./siteInspectionCache.ts', import.meta.url)), 'utf8');
const rollbackProof = readFileSync(fileURLToPath(new URL('../.github/workflows/phase1-rollback-proof.yml', import.meta.url)), 'utf8');

test('migration 152 is present and sorts after every earlier migration', () => {
  const files = readdirSync(migrationsDir).filter(name => name.endsWith('.sql')).sort();
  assert.ok(files.includes('149_discovery_integrity_state.sql'));
  assert.ok(files.includes('150_site_inspection_pending_claims.sql'));
  assert.ok(files.includes('151_youtube_key_cap_shadow_settled.sql'));
  assert.ok(files.includes('152_discord_candidate_first_validated.sql'));
  assert.equal(files[files.length - 1], '152_discord_candidate_first_validated.sql', '152 is the newest migration');
});

test('migration 152 records and backfills only successful Discord validation time', () => {
  assert.match(firstValidatedMigration, /ALTER TABLE discord_candidates ADD COLUMN IF NOT EXISTS first_validated_at TIMESTAMPTZ;/);
  assert.match(firstValidatedMigration, /operational_outcome='SUCCEEDED'/);
  assert.match(firstValidatedMigration, /MIN\(checked_at\)/);
  assert.match(firstValidatedMigration, /GROUP BY channel_id, lower\(COALESCE\(resolved_locator, invite_locator\)\)/);
  assert.match(firstValidatedMigration, /dc\.normalized_locator=successful_validation\.normalized_locator/);
  assert.match(firstValidatedMigration, /dc\.first_validated_at IS NULL OR dc\.first_validated_at > successful_validation\.first_validated_at/);
  assert.match(firstValidatedMigration, /LEAST\(COALESCE\(first_validated_at,NEW\.checked_at\),NEW\.checked_at\)/);
  assert.doesNotMatch(firstValidatedMigration, /discovered_at\s*\)?\s*AS\s+first_validated_at/i, 'discovery time is never used as confirmation time');
  assert.doesNotMatch(firstValidatedMigration, /discord_invite_registry[\s\S]*first_validated_at/i, 'registry first-seen time is never used as confirmation time');
});

test('migration 151 adds only the inert shadow settlement fence', () => {
  assert.match(shadowSettlementMigration, /CREATE TABLE IF NOT EXISTS youtube_key_cap_shadow_settled/);
  assert.match(shadowSettlementMigration, /PRIMARY KEY \(quota_day, operation_id\)/);
  assert.match(shadowSettlementMigration, /CREATE INDEX IF NOT EXISTS youtube_key_cap_shadow_settled_expiry_idx/);
  assert.doesNotMatch(shadowSettlementMigration, /\b(?:DROP|DELETE|TRUNCATE|UPDATE)\b/i, 'settlement migration is additive-only');
});

test('migration 150 adds only the per-channel pending-candidate map', () => {
  assert.match(pendingClaimsMigration, /ALTER TABLE site_inspections ADD COLUMN IF NOT EXISTS pending_claims JSONB NOT NULL DEFAULT '\{\}'::jsonb;/);
  assert.match(pendingClaimsMigration, /site_inspections_pending_claims_object_check[\s\S]*?CHECK \(jsonb_typeof\(pending_claims\) = 'object'\) NOT VALID;/);
  assert.doesNotMatch(pendingClaimsMigration, /\b(?:DROP|DELETE|TRUNCATE|UPDATE)\b/i, 'pending-claims migration is additive-only');
});

test('rollback proof seeds only the pre-146 lineage', () => {
  assert.match(rollbackProof, /if \[ "\$version" -gt 145 \]; then continue; fi/, 'migration 150+ is filtered by numeric version');
  assert.doesNotMatch(rollbackProof, /grep -vE '\//, 'the fixed 14x exclusion regex must not return');
});

test('migration 149 is additive-only (no drops, deletes, or rewrites)', () => {
  // Strip comments and reject destructive keywords anywhere in a fragment,
  // not only at the fragment start: ALTER TABLE ... DROP, DO blocks, and
  // comment-hidden statements must all fail the guard.
  const withoutComments = migration
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/--[^\n]*/g, ' ');
  const statements = withoutComments.replace(/COMMENT ON[^;]+;/g, '').split(';').map(part => part.trim()).filter(Boolean);
  assert.ok(statements.length > 0);
  for (const statement of statements) {
    assert.doesNotMatch(statement, /\b(?:DROP|DELETE|TRUNCATE|UPDATE)\b/i, `destructive statement: ${statement.slice(0, 80)}`);
  }
  assert.match(migration, /ALTER TABLE site_inspections ADD COLUMN IF NOT EXISTS source_channel_id TEXT;/);
  assert.match(migration, /ALTER TABLE site_inspections ADD COLUMN IF NOT EXISTS claim_status TEXT NOT NULL DEFAULT 'NONE';/);
  assert.match(migration, /ALTER TABLE channels ADD COLUMN IF NOT EXISTS community_discovery_status TEXT NOT NULL DEFAULT 'NONE';/);
  assert.match(migration, /ALTER TABLE channels ADD COLUMN IF NOT EXISTS community_intents JSONB NOT NULL DEFAULT '\[\]'::jsonb;/);
  assert.match(migration, /ALTER TABLE channels ADD COLUMN IF NOT EXISTS discord_duplicate_owner_channel_id TEXT;/);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS discovery_recovery_audit/);
  assert.match(migration, /ALTER TABLE site_inspections ADD CONSTRAINT site_inspections_claim_status_check[\s\S]*?NOT VALID;/);
  assert.match(migration, /ALTER TABLE channels ADD CONSTRAINT channels_community_discovery_status_check[\s\S]*?NOT VALID;/);
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

test('dbCore writes and reads the same claim/community/pending column names', () => {
  assert.match(dbCore, /INSERT INTO site_inspections\(site_identity,identity_tier,identity_basis,canonical_url,final_url,outcome,retryable,http_status,failure_class,detail,payload_checksum,candidates,observations,rendered_covered,source_channel_id,claim_status,community_intents,provenance,pending_claims,/);
  assert.match(dbCore, /pendingClaims: pendingClaimsFromColumn\(item\.pending_claims\),/);
  assert.match(dbCore, /sourceChannelId: typeof item\.source_channel_id === 'string' \? item\.source_channel_id : null,/);
  assert.match(dbCore, /claimStatus: text\(item\.claim_status\),/);
});

test('claim handshake only finalizes PENDING rows for the executing channel and its candidates', () => {
  // A CLAIMED/DISCARDED row is terminal; an unclaimed (NONE) row is never
  // promoted, because NONE with candidates must keep forcing a recrawl.
  assert.match(siteCache, /export const SITE_INSPECTION_CLAIM_STATUS = \{/);
  assert.match(dbCore, /async function finalizeSiteInspectionClaims\(/);
  assert.match(dbCore, /WHERE claim_status='PENDING'[\s\S]*?FOR UPDATE/);
  assert.match(dbCore, /export async function markSiteInspectionsDiscarded\(/);
  assert.match(siteCache, /if \(row\.claimStatus === SITE_INSPECTION_CLAIM_STATUS\.PENDING\) return false;/);
  assert.match(siteCache, /if \(row\.claimStatus !== SITE_INSPECTION_CLAIM_STATUS\.CLAIMED && row\.claimStatus !== SITE_INSPECTION_CLAIM_STATUS\.DISCARDED\) return false;/);
});

test('site-cache upsert preserves all writers pending candidates independently', () => {
  assert.match(dbCore, /site_inspections\.claim_status='PENDING' AND jsonb_array_length\(site_inspections\.candidates\)>0 AND jsonb_array_length\(excluded\.candidates\)=0 THEN site_inspections\.candidates/);
  assert.match(dbCore, /pending_claims=CASE[\s\S]*?jsonb_build_object\(\s*excluded\.source_channel_id,/);
  assert.match(dbCore, /SELECT DISTINCT ON \(COALESCE\(NULLIF\(candidate->>'candidateId',''\), 'ord:'\|\|ord\)\)/, 'same-channel seed writes merge by candidate id');
  assert.match(dbCore, /COALESCE\(site_inspections\.pending_claims->excluded\.source_channel_id,'\[\]'::jsonb\)/, 'the merge retains this channel\'s earlier seed candidates');
  assert.match(siteCache, /const ownPending = typeof borrower\.channelId === 'string'/);
  assert.match(siteCache, /row: \{ \.\.\.row, candidates: \[\], pendingClaims: \{\} \}/);
});
