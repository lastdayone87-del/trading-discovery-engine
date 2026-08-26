-- Phase 2: explicitly enable autonomous continuation execution.
-- This changes only the boolean control; existing page-depth and low-yield limits
-- remain exactly as configured in app_settings.
INSERT INTO app_settings(setting_key, setting_value)
VALUES ('autonomous_pagination_enabled', 'true')
ON CONFLICT (setting_key) DO UPDATE
SET setting_value = 'true';

-- Intentionally do not modify:
--   autonomous_pagination_max_pages
--   autonomous_pagination_max_low_yield_pages
-- Their current production values remain the governing limits.
