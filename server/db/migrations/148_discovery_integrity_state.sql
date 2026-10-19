-- Migration 148: discovery-integrity state additions (P1-P4).
--
-- Additive columns only; no backfills, no constraint validation, no data
-- deletion, safe inside the single-transaction runner (matching 134/146/147).
--
-- 1. site_inspections claim handshake (E2/E10):
--    - source_channel_id: the channel whose inspection wrote the row. Used
--      ONLY for same-owner recovery of unclaimed candidates and for the
--      claim handshake; cross-creator borrows never read another creator's
--      candidates and are re-attributed to the borrower downstream.
--    - claim_status: NONE (no candidates), PENDING (candidates persisted,
--      admission not yet committed), CLAIMED (admission committed for the
--      recording channel; candidate-bearing rows may serve as neutral
--      coverage), DISCARDED (terminal). Candidate-bearing rows in NONE/
--      PENDING are never reusable: a crash between persist and admission
--      must force an idempotent recrawl, never a silent loss.
--
-- 2. channels community-intent state (P4):
--    - community_discovery_status: NONE when no platform-community surface
--      was observed; COMMUNITY_INDICATED_NO_INVITE when a Whop/Skool/Circle/
--      Patreon surface was observed without a verified Discord invite;
--      PAID_COMMUNITY_INDICATED when paid/private access was confirmed
--      (price/membership evidence or a confirmed paywall). This state exists
--      so "community exists but no Discord invite verified" is never
--      collapsed into "no community found".
--    - community_intents: evidence array (platform, URL, intent kind,
--      signals, observation provenance). Extraction-only: never an invite,
--      never a registry claim, never validated.

ALTER TABLE site_inspections ADD COLUMN IF NOT EXISTS source_channel_id TEXT;
ALTER TABLE site_inspections ADD COLUMN IF NOT EXISTS claim_status TEXT NOT NULL DEFAULT 'NONE';
DO $$ BEGIN
  ALTER TABLE site_inspections ADD CONSTRAINT site_inspections_claim_status_check
    CHECK (claim_status IN ('NONE','PENDING','CLAIMED','DISCARDED'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE INDEX IF NOT EXISTS idx_site_inspections_source_channel
  ON site_inspections(source_channel_id, claim_status) WHERE source_channel_id IS NOT NULL;

ALTER TABLE channels ADD COLUMN IF NOT EXISTS community_discovery_status TEXT NOT NULL DEFAULT 'NONE';
DO $$ BEGIN
  ALTER TABLE channels ADD CONSTRAINT channels_community_discovery_status_check
    CHECK (community_discovery_status IN ('NONE','COMMUNITY_INDICATED_NO_INVITE','PAID_COMMUNITY_INDICATED'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
ALTER TABLE channels ADD COLUMN IF NOT EXISTS community_intents JSONB NOT NULL DEFAULT '[]'::jsonb;
DO $$ BEGIN
  ALTER TABLE channels ADD CONSTRAINT channels_community_intents_array_check
    CHECK (jsonb_typeof(community_intents) = 'array');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

COMMENT ON COLUMN site_inspections.source_channel_id IS
  'Channel whose inspection wrote this row (same-owner recovery + claim handshake only; never ownership transfer).';
COMMENT ON COLUMN site_inspections.claim_status IS
  'Candidate claim handshake: NONE/PENDING rows with candidates are never reusable coverage.';
COMMENT ON COLUMN channels.community_discovery_status IS
  'P4 platform-community intent: community observed without a verified Discord invite is never "no community found".';
COMMENT ON COLUMN channels.community_intents IS
  'P4 evidence array for observed Whop/Skool/Circle/Patreon surfaces; extraction-only, never an invite.';

-- 3. Explicit recovery audit (P3 item 12): every candidate recovered from
--    cache or historical evidence gets an explicit row. Recovery re-enters the
--    normal admission path; this table records that it happened, for which
--    channel, and which candidate identities.
CREATE TABLE IF NOT EXISTS discovery_recovery_audit (
  id BIGSERIAL PRIMARY KEY,
  channel_id TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('CACHE','HISTORICAL')),
  site_identity TEXT,
  candidate_ids JSONB NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(candidate_ids) = 'array'),
  candidate_count INTEGER NOT NULL DEFAULT 0 CHECK (candidate_count >= 0),
  detail TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_discovery_recovery_audit_channel
  ON discovery_recovery_audit(channel_id, created_at DESC);
COMMENT ON TABLE discovery_recovery_audit IS
  'P3 recovery audit: explicit row whenever candidates are recovered from cache/historical evidence.';
