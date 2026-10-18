-- Keyset cursor index for the batched country-exclusion audit.
-- fetchExclusionAuditBatch orders by (first_seen DESC, channel_id DESC).
-- The existing idx_channels_first_seen_desc is (first_seen DESC, channel_id)
-- with an ASC tie-break, so it cannot satisfy the audit's ordering without
-- an extra sort. This composite matches the cursor predicate and order.
CREATE INDEX IF NOT EXISTS idx_channels_exclusion_audit_cursor
  ON channels(first_seen DESC, channel_id DESC);
