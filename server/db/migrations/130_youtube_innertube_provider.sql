-- Migration 130: YouTube.js (InnerTube) discovery provider — fully ACTIVE.
--
-- Registers the quota-free InnerTube channel-search provider alongside the
-- official YouTube Data API v3 row. Both rows carry SEARCH_YOUTUBE so either
-- may serve discovery allocations; accounting stays separate via the dedicated
-- YOUTUBE_INNERTUBE_FREE quota domain (zero official units are ever charged
-- for InnerTube traffic). No changes to the official youtube-search row.

INSERT INTO discovery_provider_registry (
  provider_key, provider_family, provider_kind, capabilities, quota_domain,
  terms_reference, mode, daily_cost_cap, updated_by
) VALUES (
  'youtube-innertube', 'youtube', 'RETRIEVAL',
  '["SEARCH_YOUTUBE"]'::jsonb,
  'YOUTUBE_INNERTUBE_FREE', 'https://www.youtube.com/t/terms',
  'ACTIVE', 0, 'system:migration-130'
) ON CONFLICT (provider_key) DO UPDATE SET
  capabilities = EXCLUDED.capabilities,
  quota_domain = EXCLUDED.quota_domain,
  terms_reference = EXCLUDED.terms_reference,
  mode = EXCLUDED.mode,
  updated_at = now();
