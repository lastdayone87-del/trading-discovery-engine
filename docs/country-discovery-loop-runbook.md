# Country Discovery Loop (CDL) runbook

This runbook covers activation, health checks, kill switches, rollback, and the optional paid-provider
decision rule for the Country Discovery Loop. It implements the operating requirements in the approved
consolidated plan. It does not authorize a production probe or a paid-provider call.

## 1. Activation posture

CDL core functionality activates as part of the approved merge/deploy. There is no second "enable" command
for:

- `country_discovery_loop_enabled`;
- `autonomous_pagination_enabled` / `autonomous_pagination_v2_enabled`;
- `native_evidence_promotion_v2_enabled`;
- `native_vocabulary_extraction_enabled`;
- `free_query_signals_enabled`.

Migration `161_country_discovery_loop.sql` seeds those settings to `true` with
`ON CONFLICT(setting_key) DO NOTHING`. A pre-existing explicit operator value is therefore preserved. If an
operator intentionally set a core kill switch to `false` before deploy, the migration does not silently
override it; the `core_kill_switches` health check reports a `WARN` naming the disabled path. Resolve that
conflict explicitly (either accept the intentional kill switch or re-enable it) as part of deployment.

Only the paid demand adapter remains off:

- `query_demand_signals_enabled=false` because paid credentials and legal review are external prerequisites.
- `wikimedia_pageviews_enabled=false` is an optional-source choice, not a deferred activation.

### Deployment prerequisites

1. Migration 161 is part of the normal migration step. It is additive and idempotent; it does not drop
   tables/columns, delete data, rewrite unrelated settings, or change country scope.
2. `WIKIMEDIA_USER_AGENT` must be set to a descriptive agent with a real contact URL or email before free
   signals are enabled. The built-in fallback names this prerequisite instead of using a fake address; the
   `wikimedia_user_agent` health check warns when it is unset.
3. `youtube_key_daily_cap_enforced` must remain `true`. The CDL migration does not change it.
4. No paid-provider credential is required. The core path and its tests run with the paid adapter absent.

## 2. Health and metrics endpoints

Both routes are operator routes requiring the `country-discovery.read` action:

| Route | Purpose |
|---|---|
| `GET /api/country-discovery/health` | Deploy/operating gate. Returns `200` for `HEALTHY`/`DEGRADED`, `503` for `UNHEALTHY`. |
| `GET /api/country-discovery/metrics` | Page, run, country, source, provider, AI, and lifecycle metrics. |

### Health checks

| Check id | What it verifies | Typical response |
|---|---|---|
| `migration_161` | Migration 161 is recorded. | `FAIL` means the migration did not apply. |
| `required_schema` | Required CDL tables/columns exist. | `FAIL` lists missing schema. |
| `youtube_hard_cap` | `youtube_key_daily_cap_enforced=true`. | `FAIL` means the hard cap is not enforced. |
| `orphaned_pending_pages` | Pending pages older than 15 minutes. | `WARN` when any are due; inspect the reconciler. |
| `provider_canary` | Recent provider telemetry success rate (no active probe). | `FAIL` below 50% success. |
| `provider_spike` | Recent error/timeout/rate-limit rates. | `WARN` at 10%, `FAIL` at 25%. |
| `quota_reservation_failures` | Quota deferrals above the prior-hour baseline (the observable outcome of reservation denials). | `WARN` on a spike. |
| `duplicate_ratio_two_windows` | Duplicate ratio for two consecutive 24-hour windows. | `WARN` in one window, `FAIL` in both at >=90%. |
| `wrong_country_two_windows` | Country precision for two consecutive windows. | `WARN` in one window, `FAIL` in both below 50%. |
| `ai_daily_cost` | AI extraction cost against the $5/day cap. | `WARN` near the cap, `FAIL` above it. |
| `ai_budget_skips` | AI budget skips versus logical calls. | `WARN` on a spike. |
| `active_country_coverage` | Configured active countries with no page in 24 hours. | `WARN`; check the sweep and fairness cursor. |
| `wikimedia_user_agent` | `WIKIMEDIA_USER_AGENT` is configured while free signals are on. | `WARN`; set a real contact before enabling. |
| `paid_demand_off` | `query_demand_signals_enabled` is not enabled. | `FAIL` if paid demand is on without separate approval. |
| `core_kill_switches` | Approved core paths are enabled. | `WARN` names any operator-disabled path. |
| `wikimedia_pageviews_off` | Optional pageviews prior stays off. | `WARN` only if enabled. |

Kill switches are advisory in the health report: an operator may intentionally disable one, which degrades
the report but does not declare the deployment broken. Migration/schema/cap/canary failures are deploy
failures.

## 3. Kill switches

| Setting | Normal | Effect when changed |
|---|---|---|
| `country_discovery_loop_enabled` | `true` | `false` stops new CDL portfolio/continuation/extraction paths. |
| `autonomous_pagination_enabled` | `true` | `false` stops child-page enqueue; runs finish after the current page. |
| `autonomous_pagination_v2_enabled` | `true` | `false` falls back to the legacy continuation policy; page metrics still record. |
| `native_evidence_promotion_v2_enabled` | `true` | `false` returns lifecycle selection to v1; v1 SQL is unchanged. |
| `native_vocabulary_extraction_enabled` | `true` | `false` stops expanded extraction; the quality-gated legacy path remains. |
| `free_query_signals_enabled` | `true` | `false` stops Wikipedia/Wikidata enrichment; terminology/seed/YouTube paths continue. |
| `wikimedia_pageviews_enabled` | `false` | Optional topic-interest prior; no core effect. |
| `query_demand_signals_enabled` | `false` | Paid adapter. Requires separate credentials, legal review, and approval. |
| `terminology_kill_switch` | `false` | `true` is an emergency hard stop before terminology DB/provider work. |

Queue controls remain authoritative. Pausing `search_jobs` stops new work without deleting pending page
state; resuming continues from the stored token/progress.

## 4. Orphaned pages and resumption

The maintenance scheduler reconciles pending autonomous pages every tick (internally throttled to five
minutes). The producer cycle also calls the reconciler with `force: true` before the queue snapshot on
non-direct-target cycles, so a deferred continuation is scheduled before new-query work. Continuation jobs
use priority 25 versus priority 20 for new queries.

If `orphaned_pending_pages` warns:

1. Confirm `continuation_status` is `RUNNING`, `DEFERRED_QUOTA`, or `DEFERRED_TIME` and `deferred_until` is
   due.
2. Confirm the run has a stored next-page token or REWALK state.
3. Let the reconciler run; do not delete pending state.
4. A run that cannot resume is marked `RESUME_UNAVAILABLE` and reported, not silently dropped.
5. A run whose country left the active autonomous scope (dormant, deselected, or excluded) is marked
   `RESUME_UNAVAILABLE` with `COUNTRY_INACTIVE`. Re-selecting the country does not resurrect that segment;
   the next producer cycle starts a new run.

## 5. Rollback

Rollback is a deploy rollback, not a data deletion:

1. Redeploy the previous approved build and leave the previous version running.
2. Migration 161 is additive; there is no down migration and no manual data repair.
3. Use the kill switches above for a narrower emergency stop. `terminology_kill_switch=true` stops
   terminology work before DB/provider calls.
4. Verify `youtube_key_daily_cap_enforced` is still `true` and the quota tracker is unchanged.
5. Do not run a production probe as part of rollback.

## 6. Optional paid-provider decision rule

Keep `query_demand_signals_enabled=false` unless all of the following are true:

1. The free-first core has run for at least two post-rollout evaluation windows.
2. At least two active countries show a persistent, measured ranking gap that free signals cannot close.
3. Expected incremental quality creators per dollar exceed the agreed threshold, using the same
   new-relevant-creator definition as the approved plan.
4. Legal/ToS review is complete and credentials are provisioned.
5. A separate approval explicitly enables the setting and the provider mode.

Paid demand must never create terminology/promotion evidence, bypass the 30% demand-only query cap,
consume or alter YouTube quota, or be required for coverage/continuation/lifecycle promotion.

## 7. Operating review

- Daily: queue health, quota, provider errors, orphaned pages, AI budget, lifecycle transitions.
- Weekly: source yield, country coverage, continuation stop reasons, duplicate/wrong-country shares.
- 30/60/90-day: free-first sufficiency, paid-provider decision rule, terminology quality, and creator
  quality per 1,000 quota units.

These reviews may change ranking weights or disable a source via its kill switch. They are not a second
activation of approved core functionality.
