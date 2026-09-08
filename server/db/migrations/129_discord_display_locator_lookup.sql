-- Performance support for the case-preserved candidate display lookup
-- (display_locator in listChannelsPage, server/dbCore.ts).
-- That lookup is, per displayed candidate row:
--   WHERE channel_id = ? AND lower(COALESCE(resolved_locator, invite_locator)) = ?
--   ORDER BY checked_at DESC LIMIT 1
-- discord_check_attempts is append-only and some channels carry 10k+ attempts
-- (rate-limit storms), where the pre-existing (channel_id, checked_at) index
-- degrades to filtering thousands of rows per lookup. This expression index
-- turns each lookup into an exact-key newest-first range scan + LIMIT 1.
-- Additive and safe: plain btree, IF NOT EXISTS, no writes to existing rows,
-- independent of migration 128 (applies cleanly before or after it).
-- NOTE: intentionally NOT created CONCURRENTLY so it runs inside the repo's
-- transactional migration runner (each file runs in BEGIN/COMMIT); the table
-- is small enough that the brief SHARE lock is negligible. NOT applied to
-- production by hand — picked up by the normal deploy/migrate path.
CREATE INDEX IF NOT EXISTS idx_discord_attempt_locator_case_time
  ON discord_check_attempts (channel_id, lower(COALESCE(resolved_locator, invite_locator)), checked_at DESC);
