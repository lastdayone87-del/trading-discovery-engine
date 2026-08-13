-- Restore autonomous discovery to the official YouTube Data API routing that
-- existed before autonomous Provider #2 became the default production path.
--
-- This is intentionally a routing rollback only. It preserves the YouTube.js
-- implementation for later controlled use, does not delete queued jobs, and
-- does not modify manual/operator search behavior.

INSERT INTO app_settings(setting_key, setting_value)
VALUES ('youtube_inner_tube_autonomous_enabled', 'false')
ON CONFLICT(setting_key) DO UPDATE
SET setting_value = EXCLUDED.setting_value;
