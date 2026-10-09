-- Reproducible primary-numerator census for the live Thompson evaluation.
-- READ-ONLY: only SELECT statements; safe to run with any read-only role.
-- Normalizes invite codes exactly as migration 138_discord_invite_registry.sql
-- (lowercase, strip query/fragment, strip known invite-host prefixes), joins
-- first-ownership from discord_invite_registry, and keeps validated rows in
-- a trailing 14-day window. Provenance: docs/LIVE_THOMPSON_EVAL_V1.md.
WITH norm AS (
  SELECT
    channel_id,
    lower(
      split_part(
        regexp_replace(
          regexp_replace(discord_invite, '[?#].*$', ''),
          '^(https?://)?(discord\.gg|discord\.com/invite|discord\.app/invite|discordapp\.com/invite|discord\.(me|io)|dsc\.gg)/+',
          ''
        ),
        '/', 1
      )
    ) AS code
  FROM channels
  WHERE discord_invite IS NOT NULL
)
SELECT count(*) AS validated_first_owned_invites_14d
FROM norm n
JOIN discord_invite_registry r
  ON r.canonical_code = n.code
 AND r.first_channel_id = n.channel_id
JOIN channels c
  ON c.channel_id = n.channel_id
WHERE c.discord_discovery_status = 'VALIDATED'
  AND r.first_seen_at >= now() - interval '14 days';
