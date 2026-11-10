-- Independent classification audit queue and labels.
--
-- Audit labels are deliberately separate from production review decisions:
-- they are collected on a stratified evidence sample, do not use production
-- classifications as ground truth, and remain correctable through the audit
-- console. Evaluation labels reuse evaluation_ground_truth_labels so the
-- existing decision-evaluation lineage can consume them.

ALTER TABLE evaluation_ground_truth_labels
  DROP CONSTRAINT IF EXISTS evaluation_ground_truth_labels_label_check;
ALTER TABLE evaluation_ground_truth_labels
  ADD CONSTRAINT evaluation_ground_truth_labels_label_check
  CHECK (label IN ('TRADING_CONFIRMED','NON_TRADING','DISPUTED','UNCERTAIN'));

ALTER TABLE evaluation_ground_truth_labels
  DROP CONSTRAINT IF EXISTS evaluation_ground_truth_labels_provenance_check;
ALTER TABLE evaluation_ground_truth_labels
  ADD CONSTRAINT evaluation_ground_truth_labels_provenance_check
  CHECK (provenance IN ('HUMAN_REVIEW','DELAYED_PRODUCTION','ADJUDICATION','AI_ASSISTED_AUDIT'));

CREATE TABLE IF NOT EXISTS classification_audit_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  cohort_key TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'PENDING'
    CHECK (status IN ('PENDING','LABELED','DISPUTED','SKIPPED')),
  evidence_snapshot JSONB NOT NULL,
  evidence_hash TEXT NOT NULL,
  proposed_label TEXT
    CHECK (proposed_label IS NULL OR proposed_label IN ('TRADING_CONFIRMED','NON_TRADING','UNCERTAIN')),
  proposed_confidence NUMERIC,
  proposed_reason_codes TEXT[] NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (cohort_key, channel_id)
);

CREATE INDEX IF NOT EXISTS idx_classification_audit_status
  ON classification_audit_items(status, created_at, id);

CREATE INDEX IF NOT EXISTS idx_classification_audit_channel
  ON classification_audit_items(channel_id, created_at DESC);
