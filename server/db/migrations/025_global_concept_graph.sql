-- Phase 10: shadow-only, country-neutral concepts and locale surfaces.
CREATE TABLE IF NOT EXISTS concepts (
  id UUID PRIMARY KEY, concept_class TEXT NOT NULL CHECK(concept_class IN ('STRATEGY','MARKET','INSTRUMENT','EDUCATION','PSYCHOLOGY','PLATFORM','FORMAT','BRAND','OTHER')),
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK(status IN ('ACTIVE','MERGED','SPLIT','RETIRED')),
  version INTEGER NOT NULL DEFAULT 1 CHECK(version>0), created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS term_surfaces (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(), literal TEXT NOT NULL, normalized TEXT NOT NULL,
  language TEXT NOT NULL DEFAULT 'und', script TEXT NOT NULL DEFAULT 'Zyyy', locale TEXT NOT NULL DEFAULT 'und',
  valid_from TIMESTAMPTZ NOT NULL DEFAULT now(), valid_to TIMESTAMPTZ, ambiguity BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(), UNIQUE(normalized,language,script,locale),
  CHECK(valid_to IS NULL OR valid_to>valid_from)
);
CREATE TABLE IF NOT EXISTS concept_surface_senses (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(), concept_id UUID NOT NULL REFERENCES concepts(id) ON DELETE RESTRICT,
  surface_id UUID NOT NULL REFERENCES term_surfaces(id) ON DELETE RESTRICT, sense_status TEXT NOT NULL DEFAULT 'PROPOSED' CHECK(sense_status IN ('PROPOSED','APPROVED','REJECTED','SUPERSEDED')),
  provenance JSONB NOT NULL DEFAULT '{}'::jsonb, version INTEGER NOT NULL DEFAULT 1, created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(concept_id,surface_id)
);
CREATE TABLE IF NOT EXISTS concept_relations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(), source_concept_id UUID NOT NULL REFERENCES concepts(id), target_concept_id UUID NOT NULL REFERENCES concepts(id),
  relation_type TEXT NOT NULL CHECK(relation_type IN ('SYNONYM','TRANSLATION','ABBREVIATION','BROADER','NARROWER','RELATED','COMBINED_WITH')),
  status TEXT NOT NULL DEFAULT 'PROPOSED' CHECK(status IN ('PROPOSED','APPROVED','REJECTED','SUPERSEDED')), provenance JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(), UNIQUE(source_concept_id,target_concept_id,relation_type), CHECK(source_concept_id<>target_concept_id)
);
CREATE TABLE IF NOT EXISTS concept_market_affinities (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(), concept_id UUID NOT NULL REFERENCES concepts(id), surface_id UUID REFERENCES term_surfaces(id),
  country TEXT NOT NULL, locale TEXT NOT NULL DEFAULT 'und', affinity NUMERIC(6,5) NOT NULL CHECK(affinity BETWEEN 0 AND 1),
  locally_eligible BOOLEAN NOT NULL DEFAULT false, evidence JSONB NOT NULL DEFAULT '{}'::jsonb, version INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(), UNIQUE(concept_id,surface_id,country,locale)
);
CREATE TABLE IF NOT EXISTS concept_moderation_decisions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(), idempotency_key TEXT NOT NULL UNIQUE, action TEXT NOT NULL CHECK(action IN ('APPROVE_SENSE','REJECT_SENSE','MERGE','SPLIT','APPROVE_RELATION','REJECT_RELATION')),
  target_id UUID NOT NULL, expected_version INTEGER NOT NULL, actor TEXT NOT NULL, reason TEXT NOT NULL, payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS concept_projection_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(), event_key TEXT NOT NULL UNIQUE, event_type TEXT NOT NULL CHECK(event_type IN ('MERGED','SPLIT','CORRECTION')),
  source_concept_id UUID NOT NULL REFERENCES concepts(id), target_concept_id UUID REFERENCES concepts(id), payload JSONB NOT NULL,
  actor TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS concept_resolution_proposals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(), proposal_key TEXT NOT NULL UNIQUE, candidate_key TEXT NOT NULL,
  surface_id UUID NOT NULL REFERENCES term_surfaces(id), proposed_concept_id UUID REFERENCES concepts(id), status TEXT NOT NULL DEFAULT 'PENDING' CHECK(status IN ('PENDING','REVIEWED','REJECTED')),
  evidence JSONB NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS concept_graph_controls (singleton BOOLEAN PRIMARY KEY DEFAULT true CHECK(singleton),resolution_paused BOOLEAN NOT NULL DEFAULT true,dual_read_enabled BOOLEAN NOT NULL DEFAULT false,compatibility_read_enabled BOOLEAN NOT NULL DEFAULT false,updated_at TIMESTAMPTZ NOT NULL DEFAULT now());
INSERT INTO concept_graph_controls(singleton) VALUES(true) ON CONFLICT DO NOTHING;
INSERT INTO queue_controls(queue_name,is_paused) VALUES('concept_resolution',true) ON CONFLICT(queue_name) DO NOTHING;

ALTER TABLE canonical_trading_terms ADD COLUMN IF NOT EXISTS concept_id UUID REFERENCES concepts(id);
ALTER TABLE canonical_trading_terms ADD COLUMN IF NOT EXISTS surface_id UUID REFERENCES term_surfaces(id);
ALTER TABLE trading_term_aliases ADD COLUMN IF NOT EXISTS surface_id UUID REFERENCES term_surfaces(id);
ALTER TABLE terminology_observations ADD COLUMN IF NOT EXISTS concept_id UUID REFERENCES concepts(id);
ALTER TABLE terminology_observations ADD COLUMN IF NOT EXISTS surface_id UUID REFERENCES term_surfaces(id);

-- Preserve every legacy identifier: each old canonical term begins as its own meaning.
INSERT INTO concepts(id,concept_class)
SELECT (substr(md5('legacy-concept:'||id),1,8)||'-'||substr(md5('legacy-concept:'||id),9,4)||'-4'||substr(md5('legacy-concept:'||id),14,3)||'-a'||substr(md5('legacy-concept:'||id),18,3)||'-'||substr(md5('legacy-concept:'||id),21,12))::uuid,
 CASE term_type WHEN 'INSTRUMENT' THEN 'INSTRUMENT' WHEN 'FORMAT' THEN 'FORMAT' WHEN 'BRAND' THEN 'BRAND' ELSE 'OTHER' END
FROM canonical_trading_terms ON CONFLICT DO NOTHING;
INSERT INTO term_surfaces(literal,normalized,language,script,locale,valid_from)
SELECT canonical_term,normalized_term,language,script,lower(country),COALESCE(first_observed_at,created_at) FROM canonical_trading_terms ON CONFLICT DO NOTHING;
UPDATE canonical_trading_terms t SET concept_id=(substr(md5('legacy-concept:'||t.id),1,8)||'-'||substr(md5('legacy-concept:'||t.id),9,4)||'-4'||substr(md5('legacy-concept:'||t.id),14,3)||'-a'||substr(md5('legacy-concept:'||t.id),18,3)||'-'||substr(md5('legacy-concept:'||t.id),21,12))::uuid,
 surface_id=s.id FROM term_surfaces s WHERE t.surface_id IS NULL AND s.normalized=t.normalized_term AND s.language=t.language AND s.script=t.script AND s.locale=lower(t.country);
INSERT INTO concept_surface_senses(concept_id,surface_id,sense_status,provenance)
SELECT concept_id,surface_id,'APPROVED',jsonb_build_object('legacyCanonicalTermId',id) FROM canonical_trading_terms WHERE concept_id IS NOT NULL AND surface_id IS NOT NULL ON CONFLICT DO NOTHING;
INSERT INTO term_surfaces(literal,normalized,language,script,locale)
SELECT a.alias,a.normalized_alias,a.language,a.script,lower(t.country) FROM trading_term_aliases a JOIN canonical_trading_terms t ON t.id=a.canonical_term_id ON CONFLICT DO NOTHING;
UPDATE trading_term_aliases a SET surface_id=s.id FROM canonical_trading_terms t,term_surfaces s
WHERE a.canonical_term_id=t.id AND a.surface_id IS NULL AND s.normalized=a.normalized_alias AND s.language=a.language AND s.script=a.script AND s.locale=lower(t.country);
INSERT INTO concept_surface_senses(concept_id,surface_id,sense_status,provenance)
SELECT t.concept_id,a.surface_id,'APPROVED',jsonb_build_object('legacyAliasId',a.id) FROM trading_term_aliases a JOIN canonical_trading_terms t ON t.id=a.canonical_term_id WHERE a.surface_id IS NOT NULL ON CONFLICT DO NOTHING;
INSERT INTO concept_market_affinities(concept_id,surface_id,country,locale,affinity,locally_eligible,evidence)
SELECT concept_id,surface_id,country,lower(country),1,search_eligible,jsonb_build_object('legacyCanonicalTermId',id) FROM canonical_trading_terms WHERE concept_id IS NOT NULL ON CONFLICT DO NOTHING;
UPDATE terminology_observations o SET concept_id=t.concept_id,surface_id=COALESCE((SELECT a.surface_id FROM trading_term_aliases a WHERE a.id=o.alias_id),t.surface_id)
FROM canonical_trading_terms t WHERE o.canonical_term_id=t.id AND o.concept_id IS NULL;

CREATE OR REPLACE VIEW phase10_legacy_term_compatibility AS SELECT t.id,t.country,t.canonical_term,t.normalized_term,t.lifecycle_status,t.search_eligible,t.concept_id,t.surface_id FROM canonical_trading_terms t;
CREATE INDEX IF NOT EXISTS idx_surface_normalized ON term_surfaces(normalized,language,locale);
CREATE INDEX IF NOT EXISTS idx_sense_surface ON concept_surface_senses(surface_id,sense_status);
CREATE INDEX IF NOT EXISTS idx_affinity_country ON concept_market_affinities(country,locally_eligible);
DO $$ DECLARE t TEXT; BEGIN FOREACH t IN ARRAY ARRAY['concept_moderation_decisions','concept_projection_events'] LOOP
 EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION reject_immutable_event_mutation()',t||'_immutable',t);
END LOOP; END $$;
COMMENT ON TABLE concepts IS 'Phase 10 shadow graph; it is not a planner dependency and cannot grant cross-country eligibility.';
