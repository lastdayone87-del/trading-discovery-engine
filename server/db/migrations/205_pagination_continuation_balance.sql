-- Align the global discovery safety ceiling with the approved CDL 50-page
-- bound. Migration 161 intentionally preserved the legacy 10 while operators
-- decided; the production deployment inspected for this change still had that
-- seeded value. The schema has no provenance column, so a deliberate operator
-- 10 cannot be distinguished; this migration follows the approved policy and
-- raises only the exact value 10. An operator who intentionally wants 10 must
-- reapply it after deploy. Any other value is untouched.
UPDATE app_settings
   SET setting_value = '50'
 WHERE setting_key = 'autonomous_pagination_max_pages'
   AND setting_value = '10';

-- A single shallow low-novelty arm run is not enough evidence to cool a whole
-- lane for two weeks. Require either multiple probes or enough completed pages
-- before applying the arm-level novelty cooldown.
INSERT INTO app_settings(setting_key, setting_value)
VALUES ('query_arm_min_probe_runs', '2')
ON CONFLICT (setting_key) DO NOTHING;

INSERT INTO app_settings(setting_key, setting_value)
VALUES ('query_arm_min_probe_pages', '5')
ON CONFLICT (setting_key) DO NOTHING;
