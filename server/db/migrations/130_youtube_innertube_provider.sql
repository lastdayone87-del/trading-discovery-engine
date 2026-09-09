-- Migration 130: YouTube.js (InnerTube) discovery provider — fully ACTIVE.
--
-- Registers the quota-free InnerTube channel-search provider alongside the
-- official YouTube Data API v3 row. Both rows carry SEARCH_YOUTUBE so either
-- may serve discovery allocations; accounting stays separate via the dedicated
-- YOUTUBE_INNERTUBE_FREE quota domain (zero official units are ever charged
-- for InnerTube traffic). No changes to the official youtube-search row.
--
-- Idempotency / operator-state preservation: mode is seeded as ACTIVE only
-- on first insert. Re-running this migration must NEVER overwrite an
-- operator-controlled mode (PAUSED, RETIRED, CANARY, or SHADOW assignments
-- would otherwise be resurrected to ACTIVE on every deploy), so the
-- ON CONFLICT clause syncs only definition columns — mirroring migration
-- 112 (brave-search), which likewise leaves mode untouched on conflict.

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
  updated_at = now();
