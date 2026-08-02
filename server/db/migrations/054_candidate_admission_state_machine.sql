-- Release 1: product visibility is an orthogonal, replayable decision.
ALTER TABLE investigations DROP CONSTRAINT IF EXISTS investigations_state_check;
ALTER TABLE investigations ADD CONSTRAINT investigations_state_check CHECK(state IN
 ('ACTIVE','COMPLETED','NEEDS_REVIEW','UNRESOLVED','OPERATIONALLY_BLOCKED','POLICY_REJECTED','FAILED','SUPERSEDED'));
CREATE TABLE IF NOT EXISTS channel_admission_decisions (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(), decision_key TEXT NOT NULL UNIQUE, channel_id TEXT NOT NULL,
 prior_state TEXT NOT NULL, resulting_state TEXT NOT NULL,
 classification_status TEXT NOT NULL, investigation_state TEXT NOT NULL,
 candidate_hypothesis JSONB NOT NULL DEFAULT '{}'::jsonb, evidence_coverage JSONB NOT NULL DEFAULT '{}'::jsonb,
 reason_codes JSONB NOT NULL, input_snapshot JSONB NOT NULL, input_checksum TEXT NOT NULL, output_checksum TEXT NOT NULL,
 classification_diagnostic_id UUID REFERENCES production_classification_diagnostics(id) ON DELETE RESTRICT,
 investigation_id UUID REFERENCES investigations(id) ON DELETE RESTRICT,
 review_id UUID REFERENCES channel_review_decisions(id) ON DELETE RESTRICT,
 policy_version TEXT NOT NULL, mode TEXT NOT NULL CHECK(mode IN('OFF','SHADOW','CANARY','ACTIVE')),
 decided_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 CHECK(jsonb_typeof(candidate_hypothesis)='object'), CHECK(jsonb_typeof(evidence_coverage)='object'),
 CHECK(jsonb_typeof(reason_codes)='array'), CHECK(jsonb_typeof(input_snapshot)='object')
);
CREATE INDEX IF NOT EXISTS idx_admission_decisions_channel ON channel_admission_decisions(channel_id,decided_at DESC);

CREATE TABLE IF NOT EXISTS channel_admission_events (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(), event_key TEXT NOT NULL UNIQUE, channel_id TEXT NOT NULL,
 decision_id UUID NOT NULL REFERENCES channel_admission_decisions(id) ON DELETE RESTRICT,
 event_type TEXT NOT NULL CHECK(event_type IN('ADMISSION_DECIDED','ADMISSION_SUPERSEDED','LEGACY_COMPATIBILITY_ASSIGNED')),
 expected_projection_version INTEGER NOT NULL CHECK(expected_projection_version>=0), payload JSONB NOT NULL,
 policy_version TEXT NOT NULL, occurred_at TIMESTAMPTZ NOT NULL DEFAULT now(), CHECK(jsonb_typeof(payload)='object')
);
CREATE INDEX IF NOT EXISTS idx_admission_events_replay ON channel_admission_events(channel_id,occurred_at,id);

CREATE TABLE IF NOT EXISTS channel_admission_projection (
 channel_id TEXT PRIMARY KEY, channel_entity_id UUID REFERENCES canonical_entities(id) ON DELETE RESTRICT,
 state TEXT NOT NULL CHECK(state IN('NOT_EVALUATED','LEGACY_VISIBLE','WITHHELD_INVESTIGATING','ADMITTED_CONFIRMED','ADMITTED_REVIEW',
 'WITHHELD_NO_PLAUSIBLE_HYPOTHESIS','WITHHELD_OPERATIONAL_FAILURE','WITHHELD_POLICY','WITHHELD_TERMINAL_NON_TRADING','SUPERSEDED')),
 version INTEGER NOT NULL CHECK(version>0), decision_id UUID NOT NULL REFERENCES channel_admission_decisions(id) ON DELETE RESTRICT,
 investigation_id UUID REFERENCES investigations(id) ON DELETE RESTRICT,
 classification_diagnostic_id UUID REFERENCES production_classification_diagnostics(id) ON DELETE RESTRICT,
 review_id UUID REFERENCES channel_review_decisions(id) ON DELETE RESTRICT, policy_version TEXT NOT NULL,
 evidence_checksum TEXT NOT NULL, reason_codes JSONB NOT NULL, legacy_compatibility BOOLEAN NOT NULL DEFAULT false,
 decided_at TIMESTAMPTZ NOT NULL, updated_at TIMESTAMPTZ NOT NULL DEFAULT now(), CHECK(jsonb_typeof(reason_codes)='array')
);
CREATE INDEX IF NOT EXISTS idx_admission_projection_state ON channel_admission_projection(state,updated_at DESC);

DO $$ DECLARE t TEXT; BEGIN FOREACH t IN ARRAY ARRAY['channel_admission_decisions','channel_admission_events'] LOOP
 EXECUTE format('CREATE TRIGGER %I_immutable BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION reject_immutable_event_mutation()',t,t);
END LOOP; END $$;
INSERT INTO app_settings(setting_key,setting_value) VALUES
 ('candidate_admission_mode','OFF'),('candidate_admission_canary_basis_points','0')
ON CONFLICT(setting_key) DO NOTHING;
COMMENT ON TABLE channel_admission_projection IS 'Repairable serving-eligibility projection. It never overrides trading classification.';
COMMENT ON TABLE channel_admission_decisions IS 'Immutable admission decisions; OFF and SHADOW decisions have no serving authority.';

-- Existing rows receive an explicit compatibility assignment. This is not an
-- inferred historical admission and has no effect on the legacy dashboard SQL.
WITH inserted AS (
 INSERT INTO channel_admission_decisions(decision_key,channel_id,prior_state,resulting_state,classification_status,investigation_state,candidate_hypothesis,evidence_coverage,reason_codes,input_snapshot,input_checksum,output_checksum,policy_version,mode)
 SELECT 'legacy-compatibility:'||channel_id,channel_id,'NOT_EVALUATED','LEGACY_VISIBLE',COALESCE(trading_status,'UNKNOWN'),'LEGACY',
  '{}'::jsonb,'{}'::jsonb,'["LEGACY_COMPATIBILITY_ONLY"]'::jsonb,
  jsonb_build_object('channelId',channel_id,'legacyCompatibility',true),md5(channel_id||':legacy-input'),md5(channel_id||':legacy-output'),'candidate-admission-shadow-v1','OFF'
 FROM channels ON CONFLICT(decision_key) DO NOTHING RETURNING *
), all_legacy AS (
 SELECT * FROM inserted UNION ALL SELECT d.* FROM channel_admission_decisions d WHERE d.decision_key LIKE 'legacy-compatibility:%'
), events AS (
 INSERT INTO channel_admission_events(event_key,channel_id,decision_id,event_type,expected_projection_version,payload,policy_version)
 SELECT 'legacy-compatibility-event:'||channel_id,channel_id,id,'LEGACY_COMPATIBILITY_ASSIGNED',0,
  jsonb_build_object('priorState','NOT_EVALUATED','resultingState','LEGACY_VISIBLE','evidenceChecksum',input_checksum,'reasonCodes',reason_codes),policy_version
 FROM all_legacy ON CONFLICT(event_key) DO NOTHING RETURNING *
)
INSERT INTO channel_admission_projection(channel_id,state,version,decision_id,policy_version,evidence_checksum,reason_codes,legacy_compatibility,decided_at)
SELECT channel_id,'LEGACY_VISIBLE',1,id,policy_version,input_checksum,reason_codes,true,decided_at FROM all_legacy
ON CONFLICT(channel_id) DO NOTHING;
