-- Migration 138: global canonical Discord invite registry (additive only).
--
-- One row per canonical invite code (lowercase), recording the first-known
-- discovery. Later discoveries of the same code by other channels are
-- discarded at the candidate choke point and never create candidate rows.
-- Same-channel rediscoveries always pass (the owning channel keeps its
-- normal validate/persist lifecycle). No existing tables are altered and no
-- existing rows are modified or deleted by this migration.

CREATE TABLE IF NOT EXISTS discord_invite_registry (
  canonical_code TEXT PRIMARY KEY,
  first_channel_id TEXT NOT NULL,
  first_seen_at TIMESTAMPTZ NOT NULL,
  first_source_surface TEXT,
  first_source_url TEXT
);

-- Backfill from existing per-channel candidates: earliest discovery wins,
-- deterministically broken by channel_id. Idempotent on rerun.
INSERT INTO discord_invite_registry(canonical_code, first_channel_id, first_seen_at, first_source_surface, first_source_url)
SELECT ranked.code, ranked.channel_id, ranked.discovered_at, ranked.source_surface, ranked.source_url
FROM (
  SELECT lower(regexp_replace(dc.normalized_locator, '^https://discord\.gg/', '')) AS code,
         dc.channel_id,
         dc.discovered_at,
         dc.source_surface,
         dc.source_url,
         ROW_NUMBER() OVER (
           PARTITION BY lower(regexp_replace(dc.normalized_locator, '^https://discord\.gg/', ''))
           ORDER BY dc.discovered_at ASC, dc.channel_id ASC
         ) AS rn
  FROM discord_candidates dc
  WHERE dc.normalized_locator ~* '^https://discord\.gg/[^/[:space:]]+$'
) ranked
WHERE ranked.rn = 1 AND ranked.code <> ''
ON CONFLICT (canonical_code) DO NOTHING;
