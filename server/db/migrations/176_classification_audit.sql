-- Independent classification audit queue and labels.
--
-- Audit labels are deliberately isolated from evaluation_ground_truth_labels:
-- that table feeds the sealed decision-evaluation dataset and accepts only
-- human/adjudicated production labels. Reusing it would let AI-assisted audit
-- labels and UNCERTAIN cases contaminate the sealed dataset. Audit labels have
-- their own insert-only ledger and never become production ground truth.

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
  UNIQUE (cohort_key, channel_id),
  CHECK (jsonb_typeof(evidence_snapshot)='object')
);

CREATE INDEX IF NOT EXISTS idx_classification_audit_status
  ON classification_audit_items(status, created_at, id);

CREATE INDEX IF NOT EXISTS idx_classification_audit_channel
  ON classification_audit_items(channel_id, created_at DESC);

CREATE TABLE IF NOT EXISTS classification_audit_labels (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  label_key TEXT NOT NULL UNIQUE,
  audit_item_id UUID NOT NULL REFERENCES classification_audit_items(id) ON DELETE RESTRICT,
  channel_id TEXT NOT NULL,
  label TEXT NOT NULL CHECK (label IN ('TRADING_CONFIRMED','NON_TRADING','UNCERTAIN')),
  provenance TEXT NOT NULL CHECK (provenance IN ('OPERATOR_AUDIT','AI_ASSISTED_AUDIT','ADJUDICATION')),
  reviewer TEXT NOT NULL,
  notes TEXT,
  reason_codes TEXT[] NOT NULL DEFAULT '{}',
  label_policy_version TEXT NOT NULL,
  evidence_snapshot JSONB NOT NULL,
  idempotency_key TEXT,
  labeled_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (jsonb_typeof(evidence_snapshot)='object'),
  CHECK (length(trim(reviewer))>0)
);

CREATE INDEX IF NOT EXISTS idx_classification_audit_labels_item
  ON classification_audit_labels(audit_item_id, labeled_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_classification_audit_labels_channel
  ON classification_audit_labels(channel_id, labeled_at DESC);

CREATE UNIQUE INDEX IF NOT EXISTS idx_classification_audit_labels_idempotency
  ON classification_audit_labels(audit_item_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

-- Corrections are new label rows; the ledger is append-only.
DROP TRIGGER IF EXISTS classification_audit_labels_immutable ON classification_audit_labels;
CREATE TRIGGER classification_audit_labels_immutable
  BEFORE UPDATE OR DELETE ON classification_audit_labels
  FOR EACH ROW EXECUTE FUNCTION reject_immutable_event_mutation();

COMMENT ON TABLE classification_audit_items IS
  'Stratified, prediction-blind evidence worklist for independent classification audit.';
COMMENT ON TABLE classification_audit_labels IS
  'Insert-only independent audit labels. Never used as production review decisions or sealed evaluation ground truth.';
