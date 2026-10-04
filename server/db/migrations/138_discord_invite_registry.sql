-- Migration 138: global canonical Discord invite registry (additive only).
--
-- One row per canonical invite code (lowercase), recording the first-known
-- discovery. Later discoveries of the same code by other channels are
-- discarded at the candidate choke point and never create candidate rows.
-- Same-channel rediscoveries keep their normal lifecycle. No existing tables
-- are altered and no existing rows are modified or deleted by this migration.
--
-- Canonicalization matches the TypeScript canonicalizer exactly: any
-- supported Discord URL form (discord.gg, discord.com/invite,
-- discord.app/invite, discordapp.com/invite, discord.me, discord.io,
-- dsc.gg), optional scheme, stripped query/fragment, first path segment,
-- lowercased, 2-128 chars, no spaces. Non-Discord locators can never
-- produce a registry entry.
--
-- Earliest-known time uses the real historical evidence: the earliest of
-- the candidate row's discovered_at and that channel's earliest validation
-- attempt for the same locator. Migration-110-imported rows carry a
-- migration-time discovered_at, so attempt timestamps are authoritative
-- where they exist. The winning row's source_surface/source_url travel
-- together with it: provenance is never synthesized across rows.

CREATE TABLE IF NOT EXISTS discord_invite_registry (
  canonical_code TEXT PRIMARY KEY,
  first_channel_id TEXT NOT NULL,
  first_seen_at TIMESTAMPTZ NOT NULL,
  first_source_surface TEXT,
  first_source_url TEXT
);

-- Backfill from existing per-channel candidates: earliest discovery wins,
-- deterministically broken by channel. Idempotent on rerun.
INSERT INTO discord_invite_registry(canonical_code, first_channel_id, first_seen_at, first_source_surface, first_source_url)
SELECT ranked.code, ranked.channel_id, ranked.first_seen, ranked.source_surface, ranked.source_url
FROM (
  SELECT coded.code AS code,
         coded.channel_id AS channel_id,
         LEAST(coded.discovered_at, COALESCE(coded.first_attempt_at, coded.discovered_at)) AS first_seen,
         coded.source_surface AS source_surface,
         coded.source_url AS source_url,
         ROW_NUMBER() OVER (
           PARTITION BY coded.code
           ORDER BY LEAST(coded.discovered_at, COALESCE(coded.first_attempt_at, coded.discovered_at)) ASC,
                    coded.channel_id ASC,
                    coded.discovered_at ASC,
                    coded.source_surface ASC,
                    coded.source_url ASC
         ) AS rn
  FROM (
    SELECT lower(
             split_part(
               regexp_replace(
                 regexp_replace(dc.normalized_locator, '[?#].*$', ''),
                 '^(https?://)?(discord\.gg|discord\.com/invite|discord\.app/invite|discordapp\.com/invite|discord\.(me|io)|dsc\.gg)/+',
                 ''
               ),
               '/', 1
             )
           ) AS code,
           dc.channel_id AS channel_id,
           dc.discovered_at AS discovered_at,
           dc.source_surface AS source_surface,
           dc.source_url AS source_url,
           MIN(ca.checked_at) AS first_attempt_at
    FROM discord_candidates dc
    LEFT JOIN discord_check_attempts ca
      ON ca.channel_id = dc.channel_id
     AND lower(COALESCE(ca.resolved_locator, ca.invite_locator)) = dc.normalized_locator
    WHERE dc.normalized_locator ~* '^https?://(discord\.gg|discord\.com/invite|discord\.app/invite|discordapp\.com/invite|discord\.(me|io)|dsc\.gg)/+[^/[:space:]]'
    GROUP BY 1, 2, 3, 4, 5
  ) coded
  WHERE coded.code <> ''
    AND coded.code NOT LIKE '% %'
    AND coded.code NOT LIKE '%/%'
    AND length(coded.code) BETWEEN 2 AND 128
) ranked
WHERE ranked.rn = 1
ON CONFLICT (canonical_code) DO NOTHING;
