-- Migration 133: idempotent YouTube quota accounting (non-destructive).
--
-- One additive table, no changes to existing tables:
--
-- youtube_quota_accounting_ops records one row per accounted provider
-- response, keyed by a caller-generated operation ID that is stable across
-- that response's accounting retries and unique per response. The charge in
-- incrementQuota() inserts here first inside the same transaction: a retry
-- after an unknown commit outcome (committed server-side, acknowledgment
-- lost) finds its own operation ID and skips the second charge instead of
-- double-counting the same response.
--
-- Operational safety: CREATE TABLE IF NOT EXISTS only, no backfills,
-- no constraint validation, safe inside the single-transaction runner.

CREATE TABLE IF NOT EXISTS youtube_quota_accounting_ops (
  op_id TEXT PRIMARY KEY,
  quota_day TEXT NOT NULL,
  key_fingerprint TEXT NOT NULL DEFAULT '',
  units INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS youtube_quota_accounting_ops_created_at_idx
  ON youtube_quota_accounting_ops(created_at);
