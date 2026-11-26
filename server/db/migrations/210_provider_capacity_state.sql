-- Migration 210: durable provider-capacity circuit state.
--
-- One row per provider account/route and operation. A quota failure opens the
-- row until the provider's reset time; workers stop semantic claims for that
-- route, while unrelated discovery keeps running. At the reset time a single
-- probe is allowed; success closes the circuit, another quota response
-- re-opens it. Local capacity-deferral echoes never create a row.
CREATE TABLE IF NOT EXISTS provider_capacity_state (
  provider text NOT NULL,
  scope_key text NOT NULL,
  operation text NOT NULL,
  state text NOT NULL CHECK (state IN ('HEALTHY','EXHAUSTED','PROBING','BLOCKED')),
  reason_code text,
  resume_at timestamptz,
  observed_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  source_event_id text,
  generation bigint NOT NULL DEFAULT 1,
  probe_lease_until timestamptz,
  last_success_at timestamptz,
  PRIMARY KEY (provider, scope_key, operation)
);

CREATE INDEX IF NOT EXISTS idx_provider_capacity_state_resume
  ON provider_capacity_state (resume_at)
  WHERE state IN ('EXHAUSTED','PROBING');

CREATE INDEX IF NOT EXISTS idx_provider_capacity_state_provider_operation
  ON provider_capacity_state (provider, operation, state);
