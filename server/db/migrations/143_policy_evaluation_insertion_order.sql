-- Explicit monotonic insertion order for policy evaluations.
-- Latest-evaluation gates previously broke evaluated_at ties with the random
-- UUID primary key (gen_random_uuid carries no insertion order), so tied
-- evaluations could resolve to the wrong row. evaluated_at ties are common
-- (same-millisecond inserts from replay + evaluation in one flow).
-- evaluation_seq is assigned from a sequence in insertion order for all new
-- rows. The table is append-only (immutable trigger rejects UPDATE/DELETE),
-- so pre-migration rows receive sequence values in scan order, which for an
-- append-only table approximates insertion order; ties among those rows now
-- resolve deterministically instead of by random UUID. Latest-evaluation
-- gates must order by (evaluated_at, evaluation_seq), never by id.
ALTER TABLE persistent_research_policy_evaluations
  ADD COLUMN evaluation_seq BIGINT GENERATED ALWAYS AS IDENTITY;
CREATE UNIQUE INDEX IF NOT EXISTS persistent_research_policy_evaluations_policy_seq
  ON persistent_research_policy_evaluations(policy_id, evaluation_seq);
CREATE INDEX IF NOT EXISTS persistent_research_policy_evaluations_latest
  ON persistent_research_policy_evaluations(policy_id, evaluated_at DESC, evaluation_seq DESC);
