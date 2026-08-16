-- Replace the original conservative 3-page rollout ceiling with a deeper
-- safety ceiling. The continuation policy still decides page-by-page whether
-- a run deserves to continue; 10 is a hard upper bound, not a target.
--
-- Preserve explicit operator overrides: only migrate the legacy seeded value.
UPDATE app_settings
SET setting_value = '10'
WHERE setting_key = 'autonomous_pagination_max_pages'
  AND setting_value = '3';

-- New installations / databases missing the setting should use the new ceiling.
INSERT INTO app_settings(setting_key, setting_value)
VALUES ('autonomous_pagination_max_pages', '10')
ON CONFLICT (setting_key) DO NOTHING;
