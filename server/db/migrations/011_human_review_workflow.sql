CREATE TYPE review_state AS ENUM ('NOT_REQUIRED','PENDING','APPROVED','REJECTED','SUPERSEDED');
CREATE TYPE review_decision AS ENUM ('APPROVE','REJECT','FORCE_RESCAN');

CREATE TABLE channel_reviews (
  channel_id TEXT PRIMARY KEY REFERENCES channels(channel_id) ON DELETE RESTRICT,
  state review_state NOT NULL DEFAULT 'PENDING',
  review_version INTEGER NOT NULL DEFAULT 1 CHECK (review_version > 0),
  evidence_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb,
  pending_since TIMESTAMPTZ,
  decided_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE channel_review_decisions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  channel_id TEXT NOT NULL REFERENCES channels(channel_id) ON DELETE RESTRICT,
  decision review_decision NOT NULL,
  previous_status review_state NOT NULL,
  resulting_status review_state NOT NULL,
  reviewer TEXT NOT NULL CHECK (length(trim(reviewer)) > 0),
  decided_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  reason TEXT NOT NULL CHECK (length(trim(reason)) > 0),
  notes TEXT,
  review_version INTEGER NOT NULL CHECK (review_version > 0),
  evidence_snapshot JSONB NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE,
  UNIQUE(channel_id, review_version)
);

CREATE INDEX channel_reviews_pending_idx ON channel_reviews(pending_since, channel_id) WHERE state='PENDING';
CREATE INDEX channel_review_decisions_history_idx ON channel_review_decisions(channel_id, decided_at DESC);

-- Decision history is append-only even for privileged application roles.
CREATE FUNCTION prevent_review_decision_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'channel_review_decisions is immutable';
END $$;
CREATE TRIGGER channel_review_decisions_immutable
  BEFORE UPDATE OR DELETE ON channel_review_decisions
  FOR EACH ROW EXECUTE FUNCTION prevent_review_decision_mutation();

-- Existing and future NEEDS_REVIEW channels enter the durable queue. Existing
-- terminal decisions are never reopened by an ordinary channel update.
CREATE FUNCTION sync_channel_review_queue() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.scan_status='NEEDS_REVIEW' OR NEW.trading_status='NEEDS_REVIEW' THEN
    INSERT INTO channel_reviews(channel_id,state,evidence_snapshot,pending_since)
    VALUES(NEW.channel_id,'PENDING',jsonb_build_object(
      'channel', to_jsonb(NEW), 'captured_at', now(), 'source', 'classification'
    ),now())
    ON CONFLICT(channel_id) DO UPDATE SET
      evidence_snapshot=CASE WHEN channel_reviews.state IN ('NOT_REQUIRED','SUPERSEDED') THEN EXCLUDED.evidence_snapshot ELSE channel_reviews.evidence_snapshot END,
      state=CASE WHEN channel_reviews.state IN ('NOT_REQUIRED','SUPERSEDED') THEN 'PENDING' ELSE channel_reviews.state END,
      pending_since=CASE WHEN channel_reviews.state IN ('NOT_REQUIRED','SUPERSEDED') THEN now() ELSE channel_reviews.pending_since END,
      review_version=CASE WHEN channel_reviews.state IN ('NOT_REQUIRED','SUPERSEDED') THEN channel_reviews.review_version+1 ELSE channel_reviews.review_version END,
      updated_at=now();
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER channels_sync_review_queue AFTER INSERT OR UPDATE OF scan_status,trading_status ON channels
  FOR EACH ROW EXECUTE FUNCTION sync_channel_review_queue();

INSERT INTO channel_reviews(channel_id,state,evidence_snapshot,pending_since)
SELECT channel_id,'PENDING',jsonb_build_object('channel',to_jsonb(c),'captured_at',now(),'source','migration'),now()
FROM channels c WHERE scan_status='NEEDS_REVIEW' OR trading_status='NEEDS_REVIEW'
ON CONFLICT(channel_id) DO NOTHING;

-- A rejected channel remains a durable deduplication tombstone. Normal writes
-- may refresh display metadata but cannot undo the human rejection.
CREATE FUNCTION protect_human_rejection() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.trading_status='HUMAN_REJECTED' AND NEW.trading_status<>'HUMAN_REJECTED'
     AND COALESCE(current_setting('app.force_review_rescan', true),'')<>'on' THEN
    RAISE EXCEPTION 'human-rejected channel requires an audited force rescan';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER channels_protect_human_rejection BEFORE UPDATE ON channels
  FOR EACH ROW EXECUTE FUNCTION protect_human_rejection();

ALTER TABLE extracted_vocabulary_sources ADD COLUMN IF NOT EXISTS provenance TEXT NOT NULL DEFAULT 'AUTOMATED';
ALTER TABLE extracted_vocabulary_sources ADD COLUMN IF NOT EXISTS eligible_after_enrichment BOOLEAN NOT NULL DEFAULT false;
