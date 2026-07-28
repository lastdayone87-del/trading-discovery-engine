-- Move previously abandoned uncertain channels into the durable enrichment lifecycle.
UPDATE channels
SET scan_status = 'ENRICHMENT_PENDING', updated_at = now()
WHERE trading_status = 'UNCERTAIN'
  AND scan_status = 'COMPLETED'
  AND country_status <> 'REJECTED'
  AND NOT EXISTS (
    SELECT 1 FROM excluded_countries e
    WHERE lower(trim(e.country_name)) = lower(trim(channels.country))
  );

INSERT INTO jobs(type, payload, priority, max_attempts, idempotency_key)
SELECT
  'ENRICH_CHANNEL',
  jsonb_build_object(
    'channelId', c.channel_id,
    'targetCountry', c.country,
    'source', c.discovery_source,
    'candidate', jsonb_build_object(
      'channelId', c.channel_id,
      'channelName', c.channel_name,
      'youtubeUrl', c.youtube_url,
      'description', '',
      'videoTitles', jsonb_build_array(),
      'locationTag', c.country,
      'channelLinks', jsonb_build_array(),
      'subscriberCount', c.subscriber_count,
      'channelThumbnailUrl', c.channel_thumbnail_url
    )
  ),
  10,
  4,
  'enrich:' || c.channel_id
FROM channels c
WHERE c.trading_status = 'UNCERTAIN'
  AND c.scan_status = 'ENRICHMENT_PENDING'
  AND c.country_status <> 'REJECTED'
  AND NOT EXISTS (
    SELECT 1 FROM excluded_countries e
    WHERE lower(trim(e.country_name)) = lower(trim(c.country))
  )
ON CONFLICT (idempotency_key) DO NOTHING;

CREATE INDEX IF NOT EXISTS idx_channels_enrichment_lifecycle
  ON channels(scan_status, trading_status)
  WHERE scan_status IN ('ENRICHMENT_PENDING', 'ENRICHING', 'NEEDS_REVIEW');
