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

`autonomous_pagination_max_pages` is the single run-level safety ceiling and is `50` after migration
`205_pagination_continuation_balance.sql`. The production deployment inspected for this change still had
the migration-096 seeded `10`; migration 205 raises that exact value to the approved `50`. The schema has no
provenance column, so a deliberate operator `10` cannot be distinguished; an operator who intentionally
wants `10` must reapply it after deploy. Any existing value other than `10` is untouched. At the ceiling, a
real continuation becomes a linked child segment rather than a `PROVIDER_EXHAUSTED` stop. InnerTube
children resume from a persisted continuation-token cursor in one request when a token is available; the
page number remains in the cursor for telemetry, and numeric cursors from older rows (or a missing token)
still work through a bounded rewalk.

### Worker lanes and admission capacity

Discovery-critical lanes are independently sized and are not clamped by the
enrichment/classification scale gate:

| Env | Default | Lane |
|---|---:|---|
| `ADMISSION_WORKER_CONCURRENCY` | 4 | admission verification |
| `CLASSIFICATION_WORKER_CONCURRENCY` | 4 | classification |
| `PROCESS_DISCOVERY_WORKER_CONCURRENCY` | 1 | process/ingestion |
| `ENRICHMENT_ONLY_WORKER_CONCURRENCY` | 3 | generic ENRICH backfill |

Each lane is capped at 20 workers by the resolver (total maximum 80). Provider
pacing, semantic cooldowns, quota reservations and daily budgets still apply
inside each job. Startup warns if the lane total exceeds `DATABASE_POOL_MAX`. The Phase 4 scale gate remains available for diagnostics
and legacy backfill policy but no longer reduces startup capacity for the four
lanes above. Raise lanes in production one step at a time while watching Gemini
success, pacing, provider latency and heartbeat failures.

`DATABASE_POOL_MAX` defaults to `25` (hard maximum 50) and should be raised
before adding many workers; the historical node-postgres default of 10 was below
the combined lane count. Heartbeats use a dedicated two-connection pool, `DATABASE_IDLE_IN_TRANSACTION_TIMEOUT_MS`
defaults to 60s, and claim-time stale recovery is throttled
(`CLAIM_STALE_RECOVERY_INTERVAL_MS`, default 60s). `JOB_STALE_AFTER_MINUTES`
defaults to 5 so a genuinely stalled lease cannot waste 15 minutes of a lane.
`ADMISSION_EVIDENCE_TIMEOUT_MS` defaults to 120s and returns a retryable partial
observation instead of holding an admission worker indefinitely.

Only the paid demand adapter remains off:

- `query_demand_signals_enabled=false` because paid credentials and legal review are external prerequisites.
- `wikimedia_pageviews_enabled=false` is an optional-source choice, not a deferred activation.

### Deployment prerequisites

1. Migration 161 is part of the normal migration step. It is additive and idempotent; it does not drop
   tables/columns, delete data, rewrite unrelated settings, or change country scope.
2. `WIKIMEDIA_USER_AGENT` must be set to a descriptive agent with a real contact URL or email before free
   signals are enabled. The built-in fallback names this prerequisite instead of using a fake address.
   While free signals are enabled and no contact-bearing agent is configured, the `wikimedia_user_agent`
   health check returns `FAIL` and the health route returns `503`; set a real contact or disable free
   signals. Reserved example domains (including `example.org`) are placeholders and do not satisfy the
   prerequisite.
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
| `discovery_scope` | `query_intelligence_discovery_scope` and `query_intelligence_selected_countries` parse under the strict runtime parsers. | `FAIL` for an invalid mode or unparseable selected-country list. |
| `orphan_pending_pages` | Pending pages older than 15 minutes. | `FAIL` when any are due; inspect the reconciler. |
| `provider_canary` | Recent provider telemetry success rate (no active probe). | `FAIL` below 50% success once the window has at least 10 calls; smaller samples are advisory `WARN` only. |
| `provider_spike` | Recent error/timeout/rate-limit rates. | `WARN` at 10%, `FAIL` at 25% once the window has at least 10 calls; smaller samples are advisory `WARN` only. |
| `quota_reservation_failures` | Quota deferrals above the prior-hour baseline (the observable outcome of reservation denials). | `WARN` on a spike. |
| `duplicate_ratio_two_windows` | Duplicate ratio for two consecutive 24-hour windows. | `WARN` in one window, `FAIL` in both at >=90%. |
| `wrong_country_two_windows` | Country precision for two consecutive windows. | `WARN` in one window, `FAIL` in both below 50%. |
| `ai_daily_cost` | AI extraction cost against the $5/day cap. | `WARN` near the cap, `FAIL` above it. |
| `ai_budget_skips` | AI budget skips versus logical calls. | `WARN` on a spike. |
| `active_country_coverage` | Configured active countries with no page in 24 hours. | `WARN`; check the sweep and fairness cursor. |
| `wikimedia_user_agent` | `WIKIMEDIA_USER_AGENT` is configured while free signals are on. | `FAIL` (health route `503`) when free signals are enabled and no contact-bearing agent is set; configure a real contact URL/email or disable free signals. |
| `paid_demand_off` | `query_demand_signals_enabled` is not enabled. | `FAIL` whenever paid demand is enabled. The check has no approval state, so separate approval does not change the health result. |
| `core_kill_switches` | Approved core paths are enabled. | `WARN` names any operator-disabled path. |
| `wikimedia_pageviews_off` | Optional pageviews prior stays off. | `WARN` only if enabled. |

Kill switches are advisory in the health report: an operator may intentionally disable one, which degrades
the report but does not declare the deployment broken. Any `FAIL` makes the route return `503`. Current
`FAIL` checks are `migration_161`, `required_schema`, `youtube_hard_cap`, `discovery_scope`,
`orphan_pending_pages`, `provider_canary`, `provider_spike` (on a sufficient sample),
`duplicate_ratio_two_windows`, `wrong_country_two_windows`, `ai_daily_cost`, `wikimedia_user_agent`, and
`paid_demand_off`.

## 3. Kill switches

| Setting | Normal | Effect when changed |
|---|---|---|
| `country_discovery_loop_enabled` | `true` | `false` stops new CDL portfolio/continuation/extraction paths. |
| `autonomous_pagination_enabled` | `true` | `false` stops child-page enqueue; runs finish after the current page. |
| `autonomous_pagination_v2_enabled` | `true` | `false` selects legacy continuation decisions; page metrics still record and the orphan reconciler remains active while `autonomous_pagination_enabled` and the CDL master switch are on. |
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
use priority 25 versus priority 20 for new queries. Both sweep paths are bounded by the configured queue
headroom, and the reconciler stays active when `autonomous_pagination_v2_enabled=false`; that setting only
switches the decision policy, it does not strand legacy pages. Disabling `autonomous_pagination_enabled` or
the CDL master switch is what stops continuation enqueue.

A page that looks low-value, wrong-country, or novelty-poor is provisional while its own admission
verdicts are still pending. The worker records the provisional stop, defers the run, and re-evaluates after
settlement. It continues when settled yield is fresh confirmed/quality, or when a settled new creator
overrides a non-novelty stop, provided the settled admission guard is not terminal. Low-novelty stops
require confirmed/quality yield because a small new-creator share was already tolerated when the stop was
chosen. Hard stops (page/provider/creator ceilings, run/time budget, quota, no next page, and
duplicate-heavy) never wait. Duplicate-heavy is measured from actual channel IDs on the page; the 30-day
production audit recorded in PR #690 found zero unseen and zero confirmed traders on those pages, so its
stop is immediate.

Discovery-arm cooldowns are evidence-gated too. An empty arm is authoritative immediately, but a
low-novelty arm is cooled only after the configured number of probes (`query_arm_min_probe_runs`, default
2) or completed pages (`query_arm_min_probe_pages`, default 5). Until then the selector tries the other
planned arms and gives the least recently probed shallow arm a bounded second probe instead of cooling the
whole query surface. Provider outages and capacity failures never consume the query-quality failure
backoff; they are owned by provider quarantine and durable suspension, and a successful run clears any
query failure streak.

If `orphan_pending_pages` reports `FAIL` (the route returns 503):

1. Confirm `continuation_status` is `RUNNING`, `DEFERRED_QUOTA`, or `DEFERRED_TIME` and `deferred_until` is
   due.
2. Confirm the run has a stored next-page token or REWALK state.
3. Let the reconciler run; do not delete pending state.
4. A run that cannot resume is marked `RESUME_UNAVAILABLE` and reported, not silently dropped.
5. A run whose country left the active autonomous scope (dormant, deselected, or excluded) is marked
   `RESUME_UNAVAILABLE` with `COUNTRY_INACTIVE`. Re-selecting the country does not resurrect that segment;
   the next producer cycle starts a new run.

### Admission rejection-share policy

Admission rejection share is measured over the uncertain admission candidates
on the current page, not over all page channels. Current-page confirmed,
quality or fresh creators — or a continuation decision marked productive —
prevent this rule from stopping the run. Yield from earlier pages only prevents
query quarantine; it does not prevent a later high-rejection page from stopping
this run.

A high rejection share stops the current run only. It does **not** permanently
reject the query. Query rejection requires all of:

- no current-page yield,
- no live run-wide quality/confirmed yield,
- no pending classification in the run,
- successfully loaded run evidence (a read failure fails closed),
- at least two prior completed runs, and
- zero historical quality and unique discoveries.

One page or one run is never enough. Use `npm run quarantine:release` (dry-run)
to review existing admission quarantines, then `-- --apply` to restore queries
with historical yield to `EXPERIMENTAL` (the normal promotion policy decides
any later `PROVEN` move). Queries with no historical yield remain rejected for
manual review. The apply update is fenced by the exact reviewed hold and
`status='REJECTED'`, so a newer hold or operator pause is never overwritten.

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
