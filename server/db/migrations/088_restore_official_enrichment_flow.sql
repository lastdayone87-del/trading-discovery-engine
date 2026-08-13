-- Restore the pre-hybrid enrichment operating mode while downstream provider
-- pressure is investigated. This disables only the persisted YouTube.js hybrid
-- enrichment feature flag; it does not remove the implementation, alter
-- autonomous discovery, delete jobs, or reset channel state.
--
-- With this setting false, ENRICH_CHANNEL returns to the official YouTube Data
-- API path and its existing quota-allocation throttle.

INSERT INTO app_settings(setting_key, setting_value)
VALUES ('youtube_js_hybrid_enrichment_enabled', 'false')
ON CONFLICT(setting_key) DO UPDATE
SET setting_value = EXCLUDED.setting_value;
