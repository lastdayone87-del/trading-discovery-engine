-- Reconcile known numeric subscriber counts below the authoritative 30-subscriber gate.
-- Preserve stronger country/trading terminal states; these rows remain stored for auditability.
UPDATE channels
SET scan_status = 'SKIPPED_LOW_AUDIENCE'
WHERE subscriber_count ~ '^[0-9]+$'
  AND subscriber_count::integer < 30
  AND country_status <> 'REJECTED'
  AND trading_status NOT IN ('NON_TRADING', 'HUMAN_REJECTED')
  AND scan_status NOT IN ('SKIPPED_EXCLUDED', 'SKIPPED_NON_TRADING', 'SKIPPED_LOW_AUDIENCE');
