-- Capacity is derived at runtime from the configured API key pool. An old
-- 9,000-unit setting must not cap a 60,000-unit pool.
INSERT INTO app_settings(setting_key,setting_value) VALUES
  ('daily_youtube_quota_budget','AUTO'),
  ('discovery_autonomous_quota_percent','70'),
  ('manual_search_quota_percent','20'),
  ('discovery_enrichment_quota_percent','10')
ON CONFLICT(setting_key) DO NOTHING;

-- Upgrade only the known legacy default. Preserve deliberate operator settings.
UPDATE app_settings SET setting_value='AUTO'
WHERE setting_key='daily_youtube_quota_budget' AND setting_value='9000';
