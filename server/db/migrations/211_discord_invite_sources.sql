-- Migration 211: retain every observed source relationship for a canonical
-- Discord invite. The registry remains one row per canonical code (global
-- dedupe/validation ownership), while this table records that multiple
-- creators, affiliates, or the actual business published the same invite.
-- Loser discoveries keep their source relationship even though their candidate
-- rows are removed at the claim choke point.
--
-- Additive only: no existing table is altered and no existing row is modified.

CREATE TABLE IF NOT EXISTS discord_invite_sources (
  canonical_code TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  source_surface TEXT NOT NULL DEFAULT '',
  source_url TEXT NOT NULL DEFAULT '',
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (canonical_code, channel_id, source_surface, source_url)
);

CREATE INDEX IF NOT EXISTS idx_discord_invite_sources_channel
  ON discord_invite_sources(channel_id, canonical_code);

-- Backfill the first-known registry provenance.
INSERT INTO discord_invite_sources(canonical_code, channel_id, source_surface, source_url, first_seen_at, last_seen_at)
SELECT canonical_code,
       first_channel_id,
       COALESCE(first_source_surface, ''),
       LEFT(COALESCE(first_source_url, ''), 384),
       first_seen_at,
       first_seen_at
FROM discord_invite_registry
ON CONFLICT (canonical_code, channel_id, source_surface, source_url) DO NOTHING;

-- Backfill candidate provenance (including historical same-code discoveries
-- that were not the registry winner). Candidate URLs are bounded here so the
-- primary-key btree entry stays within PostgreSQL's index row limit.
WITH candidate_sources AS (
  SELECT coded.code,
         coded.channel_id,
         coded.source_surface,
         coded.source_url,
         coded.discovered_at,
         (SELECT MIN(ca.checked_at)
          FROM discord_check_attempts ca
          WHERE ca.channel_id = coded.channel_id
            AND lower(COALESCE(ca.resolved_locator, ca.invite_locator)) = coded.normalized_locator) AS first_attempt_at
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
           dc.channel_id,
           dc.normalized_locator,
           COALESCE(dc.source_surface, '') AS source_surface,
           LEFT(COALESCE(dc.source_url, ''), 384) AS source_url,
           dc.discovered_at
    FROM discord_candidates dc
    WHERE dc.normalized_locator ~* '^https?://(discord\.gg|discord\.com/invite|discord\.app/invite|discordapp\.com/invite|discord\.(me|io)|dsc\.gg)/+[^/[:space:]]'
  ) coded
  WHERE coded.code <> ''
    AND coded.code NOT LIKE '% %'
    AND coded.code NOT LIKE '%/%'
    AND length(coded.code) BETWEEN 2 AND 128
)
INSERT INTO discord_invite_sources(canonical_code, channel_id, source_surface, source_url, first_seen_at, last_seen_at)
SELECT code,
       channel_id,
       source_surface,
       source_url,
       MIN(LEAST(discovered_at, COALESCE(first_attempt_at, discovered_at))),
       MAX(discovered_at)
FROM candidate_sources
GROUP BY code, channel_id, source_surface, source_url
ON CONFLICT (canonical_code, channel_id, source_surface, source_url)
DO UPDATE SET
  first_seen_at = LEAST(discord_invite_sources.first_seen_at, EXCLUDED.first_seen_at),
  last_seen_at = GREATEST(discord_invite_sources.last_seen_at, EXCLUDED.last_seen_at);

-- Runtime candidates retain every observation. Backfill those observations too
-- so a channel that saw the same invite on multiple surfaces/pages keeps each
-- relationship, not only the row's top-level source.
WITH observation_sources AS (
  SELECT dc.channel_id,
         dc.normalized_locator,
         dc.discovered_at,
         lower(
           split_part(
             regexp_replace(
               regexp_replace(dc.normalized_locator, '[?#].*$', ''),
               '^(https?://)?(discord\.gg|discord\.com/invite|discord\.app/invite|discordapp\.com/invite|discord\.(me|io)|dsc\.gg)/+',
               ''
             ),
             '/', 1
           )
         ) AS code,
         COALESCE(observation->>'sourceSurface', '') AS source_surface,
         LEFT(COALESCE(observation->>'sourceUrl', ''), 384) AS source_url
  FROM discord_candidates dc
  CROSS JOIN LATERAL jsonb_array_elements(
    CASE WHEN jsonb_typeof(dc.source_observations) = 'array' THEN dc.source_observations ELSE '[]'::jsonb END
  ) AS observation
  WHERE dc.normalized_locator ~* '^https?://(discord\.gg|discord\.com/invite|discord\.app/invite|discordapp\.com/invite|discord\.(me|io)|dsc\.gg)/+[^/[:space:]]'
)
INSERT INTO discord_invite_sources(canonical_code, channel_id, source_surface, source_url, first_seen_at, last_seen_at)
SELECT code,
       channel_id,
       source_surface,
       source_url,
       MIN(LEAST(discovered_at, COALESCE(first_attempt_at, discovered_at))),
       MAX(discovered_at)
FROM (
  SELECT os.*,
         (SELECT MIN(ca.checked_at)
          FROM discord_check_attempts ca
          WHERE ca.channel_id = os.channel_id
            AND lower(COALESCE(ca.resolved_locator, ca.invite_locator)) = os.normalized_locator) AS first_attempt_at
  FROM observation_sources os
) observed
WHERE code <> ''
  AND code NOT LIKE '% %'
  AND code NOT LIKE '%/%'
  AND length(code) BETWEEN 2 AND 128
GROUP BY code, channel_id, source_surface, source_url
ON CONFLICT (canonical_code, channel_id, source_surface, source_url)
DO UPDATE SET
  first_seen_at = LEAST(discord_invite_sources.first_seen_at, EXCLUDED.first_seen_at),
  last_seen_at = GREATEST(discord_invite_sources.last_seen_at, EXCLUDED.last_seen_at);
