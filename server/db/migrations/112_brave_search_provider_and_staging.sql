-- Migration 112: Brave Search Provider & Generic Candidate Staging

INSERT INTO discovery_provider_registry (
  provider_key, provider_family, provider_kind, capabilities, quota_domain,
  terms_reference, mode, daily_cost_cap, updated_by
) VALUES (
  'brave-search', 'brave', 'RETRIEVAL',
  '["SEARCH_BRAVE_DIRECT", "SEARCH_BRAVE_EXTERNAL_OSINT"]'::jsonb,
  'BRAVE_SEARCH_API', 'https://brave.com/search/api/terms/',
  'SHADOW', 100, 'system:migration-112'
) ON CONFLICT (provider_key) DO UPDATE SET
  capabilities = EXCLUDED.capabilities,
  quota_domain = EXCLUDED.quota_domain,
  terms_reference = EXCLUDED.terms_reference,
  updated_at = now();

-- Update discovery_actions action_type check constraint if present
DO $$
BEGIN
  ALTER TABLE discovery_actions DROP CONSTRAINT IF EXISTS discovery_actions_action_type_check;
  ALTER TABLE discovery_actions ADD CONSTRAINT discovery_actions_action_type_check
    CHECK (action_type IN (
      'SEARCH_YOUTUBE', 'SEARCH_CHANNEL', 'INSPECT_PLAYLIST', 'INSPECT_FEATURED_CHANNELS',
      'INSPECT_COLLABORATOR', 'RESOLVE_EXTERNAL_ENTITY', 'INSPECT_WEBSITE_AUTHOR',
      'MINE_TRANSCRIPT_KEYPHRASES', 'MINE_CHANNEL_CORPUS', 'PROBE_COVERAGE_CELL',
      'TEST_CROSS_LANGUAGE_SURFACE', 'REFRESH_STALE_FRONTIER', 'HUMAN_NOMINATION',
      'SEARCH_BRAVE_DIRECT', 'SEARCH_BRAVE_EXTERNAL_OSINT'
    ));
EXCEPTION WHEN OTHERS THEN
  NULL;
END $$;

-- Provider-neutral generic candidate staging table
CREATE TABLE IF NOT EXISTS discovery_candidate_staging (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  staging_key TEXT NOT NULL UNIQUE,
  provider_key TEXT NOT NULL REFERENCES discovery_provider_registry(provider_key) ON DELETE RESTRICT,
  retrieval_surface TEXT NOT NULL,
  provider_capability TEXT NOT NULL,
  candidate_type TEXT NOT NULL CHECK (candidate_type IN ('CHANNEL_ID', 'HANDLE', 'VIDEO_ID', 'EXTERNAL_EVIDENCE')),
  normalized_identity TEXT NOT NULL,
  raw_locator TEXT NOT NULL,
  query_run_id UUID REFERENCES query_runs(id) ON DELETE SET NULL,
  opportunity_key TEXT,
  country TEXT NOT NULL,
  language TEXT,
  neighborhood_key TEXT,
  discovery_mode TEXT NOT NULL CHECK (discovery_mode IN ('DIRECT_YOUTUBE', 'EXTERNAL_OSINT')),
  provenance JSONB NOT NULL DEFAULT '{}'::jsonb,
  resolution_status TEXT NOT NULL DEFAULT 'PENDING' CHECK (resolution_status IN ('PENDING', 'RESOLVED', 'FAILED', 'SKIPPED')),
  resolved_channel_id TEXT,
  validation_status TEXT NOT NULL DEFAULT 'UNVALIDATED' CHECK (validation_status IN ('UNVALIDATED', 'VALIDATED', 'REJECTED')),
  duplicate_rejection_reason TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  discovered_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_candidate_staging_provider_status ON discovery_candidate_staging(provider_key, resolution_status);
CREATE INDEX IF NOT EXISTS idx_candidate_staging_normalized ON discovery_candidate_staging(candidate_type, normalized_identity);
CREATE INDEX IF NOT EXISTS idx_candidate_staging_country ON discovery_candidate_staging(country, resolution_status);
CREATE INDEX IF NOT EXISTS idx_candidate_staging_discovered_at ON discovery_candidate_staging(discovered_at);

-- App settings for Brave control plane
INSERT INTO app_settings(setting_key, setting_value) VALUES
  ('brave_provider_mode', 'SHADOW'),
  ('brave_kill_switch', 'false'),
  ('brave_daily_request_cap', '1000'),
  ('brave_per_cycle_request_cap', '20'),
  ('brave_staging_backlog_threshold', '500'),
  ('brave_cost_per_request_usd', '')
ON CONFLICT (setting_key) DO NOTHING;
