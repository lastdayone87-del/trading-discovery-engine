-- Phase 7 replaced the legacy 30-minute scheduler with a five-minute producer.
-- Preserve every explicit non-legacy operator value while upgrading only the old
-- persisted default, which otherwise overrides DISCOVERY_INTERVAL_MINUTES.
UPDATE app_settings
SET setting_value = '5'
WHERE setting_key = 'discovery_interval_minutes'
  AND setting_value = '30';
