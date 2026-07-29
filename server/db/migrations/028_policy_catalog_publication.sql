-- Phase 13: atomic, policy-driven catalog publication. Expand-first; all history is retained.
CREATE TABLE IF NOT EXISTS serving_catalog_versions (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(), source_catalog_id UUID REFERENCES candidate_catalogs(id),
 version INTEGER NOT NULL UNIQUE CHECK(version>0), checksum TEXT NOT NULL UNIQUE, policy_version TEXT NOT NULL,
 kind TEXT NOT NULL CHECK(kind IN ('CURATED_BASELINE','CANDIDATE')), status TEXT NOT NULL DEFAULT 'DRAFT'
   CHECK(status IN ('DRAFT','APPROVED','RETIRED')), curated_share_basis_points INTEGER NOT NULL DEFAULT 10000
   CHECK(curated_share_basis_points BETWEEN 9500 AND 10000), created_by TEXT NOT NULL,
 created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS serving_catalog_entries (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(), catalog_version_id UUID NOT NULL REFERENCES serving_catalog_versions(id),
 ordinal INTEGER NOT NULL CHECK(ordinal>=0), country TEXT NOT NULL, locale TEXT NOT NULL DEFAULT 'und', lane TEXT NOT NULL,
 candidate_key TEXT NOT NULL, surface_text TEXT NOT NULL, query_spec JSONB NOT NULL DEFAULT '{}'::jsonb,
 origin TEXT NOT NULL CHECK(origin IN ('CURATED','PROVEN_CANDIDATE')), entry_checksum TEXT NOT NULL,
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(), UNIQUE(catalog_version_id,ordinal),
 UNIQUE(catalog_version_id,country,locale,lane,candidate_key)
);
CREATE TABLE IF NOT EXISTS catalog_publication_approvals_v2 (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(), catalog_version_id UUID NOT NULL REFERENCES serving_catalog_versions(id),
 idempotency_key TEXT NOT NULL UNIQUE, expected_status TEXT NOT NULL, actor TEXT NOT NULL, reason TEXT NOT NULL,
 approved_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS active_catalog_pointers (
 scope_key TEXT PRIMARY KEY, country TEXT NOT NULL, locale TEXT NOT NULL DEFAULT 'und', lane TEXT NOT NULL,
 catalog_version_id UUID NOT NULL REFERENCES serving_catalog_versions(id), pointer_version INTEGER NOT NULL DEFAULT 1 CHECK(pointer_version>0),
 updated_at TIMESTAMPTZ NOT NULL DEFAULT now(), UNIQUE(country,locale,lane)
);
CREATE TABLE IF NOT EXISTS catalog_publication_events (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(), idempotency_key TEXT NOT NULL UNIQUE, scope_key TEXT NOT NULL,
 from_catalog_version_id UUID REFERENCES serving_catalog_versions(id), to_catalog_version_id UUID NOT NULL REFERENCES serving_catalog_versions(id),
 from_pointer_version INTEGER NOT NULL CHECK(from_pointer_version>=0), to_pointer_version INTEGER NOT NULL CHECK(to_pointer_version>0),
 action TEXT NOT NULL CHECK(action IN ('PUBLISH','ROLLBACK')), checksum TEXT NOT NULL, actor TEXT NOT NULL, reason TEXT NOT NULL,
 occurred_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS catalog_lifecycle_transitions (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(), lifecycle_key TEXT NOT NULL, idempotency_key TEXT NOT NULL UNIQUE,
 from_state TEXT NOT NULL CHECK(from_state IN ('CANDIDATE','ELIGIBLE','PROVEN','STALE','SATURATED','HARMFUL','INVALID')),
 to_state TEXT NOT NULL CHECK(to_state IN ('CANDIDATE','ELIGIBLE','PROVEN','STALE','SATURATED','HARMFUL','INVALID')),
 policy_version TEXT NOT NULL, evidence_checksum TEXT NOT NULL, cooldown_until TIMESTAMPTZ, actor TEXT NOT NULL,
 reason TEXT NOT NULL, occurred_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS catalog_lifecycle_heads (
 lifecycle_key TEXT PRIMARY KEY, state TEXT NOT NULL CHECK(state IN ('CANDIDATE','ELIGIBLE','PROVEN','STALE','SATURATED','HARMFUL','INVALID')),
 version INTEGER NOT NULL DEFAULT 1 CHECK(version>0), cooldown_until TIMESTAMPTZ, last_transition_id UUID REFERENCES catalog_lifecycle_transitions(id),
 updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS catalog_manual_overrides (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(), lifecycle_key TEXT NOT NULL, idempotency_key TEXT NOT NULL UNIQUE,
 forced_state TEXT NOT NULL CHECK(forced_state IN ('ELIGIBLE','PROVEN','STALE','SATURATED','HARMFUL','INVALID')),
 expected_version INTEGER NOT NULL, expires_at TIMESTAMPTZ, actor TEXT NOT NULL, reason TEXT NOT NULL,
 created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS catalog_score_snapshots (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(), snapshot_key TEXT NOT NULL UNIQUE, lifecycle_key TEXT NOT NULL,
 lifecycle_version INTEGER NOT NULL, policy_version TEXT NOT NULL, trigger TEXT NOT NULL CHECK(trigger IN ('SCHEDULED','CONFIG_CHANGE','STATE_CHANGE')),
 scores JSONB NOT NULL, evidence_checksum TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS catalog_version_id UUID REFERENCES serving_catalog_versions(id);
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS catalog_policy_version TEXT;
CREATE INDEX IF NOT EXISTS idx_serving_catalog_scope ON serving_catalog_entries(catalog_version_id,country,locale,lane,ordinal);
DO $$ DECLARE t TEXT; BEGIN FOREACH t IN ARRAY ARRAY['serving_catalog_entries','catalog_publication_approvals_v2','catalog_publication_events','catalog_lifecycle_transitions','catalog_manual_overrides','catalog_score_snapshots'] LOOP
 EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION reject_immutable_event_mutation()',t||'_immutable',t);
END LOOP; END $$;
COMMENT ON TABLE active_catalog_pointers IS 'Only online Phase 13 dependency: an atomic pointer to an immutable compact catalog; planners never query the concept graph.';
COMMENT ON COLUMN jobs.catalog_version_id IS 'Pinned at proposal time. Old catalog versions remain readable; demotion never mutates claimed jobs.';
