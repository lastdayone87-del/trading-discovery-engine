# Probe pilot limits and canary pass/fail — 2026-10-24

Status: **planning evidence; the pilot is not authorized or runnable.** No
probe has been executed. This document records code-enforced limits and the
option-2 quota decision; it is not an activation request.

## Option-2 quota decision

Probe-origin work **may spend official YouTube quota**. It is not required to be
zero-official-unit. Every official call must first reserve from the independent
probe bucket (PR #546), and the reservation settles in the same transaction as
the official charge. When PR #533's hard cap is enabled, the same probe lease
also counts toward that key's 9,000-unit projection.

The InnerTube retrieval page is still unbilled and the probe ledger records
`units=0` for that page. That field is a **retrieval** fact, not a total-spend
claim. Delegated hydration, queued enrichment, retries, recovery, and key
failover all use the ordinary `youtubeFetch` path and must carry a probe
reservation. See [PROBE_QUOTA_ALLOCATION_20261024.md](PROBE_QUOTA_ALLOCATION_20261024.md).

## Code-enforced limits

| Limit | Value | Where enforced | Notes |
| --- | --- | --- | --- |
| Absolute run cap | 30 probes | `PROBE_DEFAULTS.maxTotal` / `PROBE_HARD_LIMITS.maxTotal`, `countProbesSince(epoch)` | Settings can only tighten, range 1..30. Counts every reserved attempt, including expired/failed attempts. |
| Global daily cap | 20 probes | `maxPerDay`, `countProbesSince(UTC day start)` | Settings can only tighten, hard ceiling 20. **UTC day**, not Pacific. |
| Per-country daily cap | 10 probes | `maxPerCountryPerDay`, same UTC day scope | Settings can only tighten, hard ceiling 10. |
| Per-candidate lifetime | 3 attempts | `maxPerCandidate` | Hard cap 3. |
| Candidate age | 14 days | `maxAgeDays` | Hard cap 14. |
| Minimum retry interval | 24 hours | `minIntervalHours` | Expired reservations do not hold the candidate for 24h. |
| In-flight TTL | 15 minutes default | `inFlightTtlMinutes` | Clamped 1..60; stale reservations are reclaimable. |
| Run deadline | Optional ISO instant | `discovery_probe_deadline` | **Config-only.** Absent means no deadline. Malformed fails closed. |
| Country allowlist | Default `US` | `discovery_probe_allowed_countries` | **Config-only.** Empty/malformed denies every country. Not a one-country structural cap. |
| Official route | Disabled | `discovery_probe_allow_official` + executor route check | Executor returns `OFFICIAL_ROUTE_NOT_IMPLEMENTED`; only `youtube-innertube` executes. This is the retrieval route; downstream official calls are governed by the quota allocation below. |
| Pages per probe | 1 | `defaultRetrievePage` passes `cursor: null` | No continuation. Page size constant 20. |
| Channels ingested | 20 per probe | `MAX_CHANNELS_INGESTED_PER_PROBE` | **Per probe, not a total across the run.** Distinct channels are capped before ingestion. |
| Probe retrieval units | 0 | Executor records `units: 0` for its one InnerTube page | Retrieval is unbilled. This is **not** a total-spend claim. |
| Probe-origin official allocation | 10,000 units/Pacific day | `youtube_probe_official_quota_enabled` + `youtube_probe_daily_cap_units` (migration 155) | Only exact `true` enables; cap must be an integer 100..min(10% budget, 20,000). Absent/malformed/unreadable fails closed. |
| Per-key projection | 9,000 units/key/Pacific day | PR #533 `youtube_key_daily_cap_enforced` | Applies to probe and non-probe leases alike when enabled. The probe reservation takes the shared key lock, so the two controls are atomic. |
| Downstream official calls | Counted and capped | `quota_origin` provenance (migration 154) + `reserveProbeQuota` before every official dispatch | Hydration, queued enrichment, retries, recovery, and failover are all probe-origin and reserve independently. |

The 72-hour window is **not structurally enforced by the code**. It is a
configuration/deadline envelope: set `discovery_probe_deadline` at start+72h and
verify that a reservation after the deadline returns `RUN_DEADLINE_PASSED`.
With the single-country 10/day cap, 30 probes require at least three UTC days;
that is the source of the “72h” intuition, not a hardcoded timer.

The one-page and 20-channel limits are per probe. There is no code-enforced
total-channel cap across the pilot; the total is bounded indirectly by
`30 probes × 20 channels = 600` ingest attempts (plus retries within a probe).
Do not describe 20 as a total.

## Canary pass/fail

A canary is one country, one approved route, and no more than 30 probes under
the table above. Evaluate only **persisted, verified, net-new** creators. A
returned channel, a review-routed channel, a known channel, or a repeat
sighting does not count. Probe origin alone is never a qualification or review
reason.

### Hard safety gates (any failure = FAIL, stop immediately)

1. **Every official call is capped and accounted.** Probe retrieval is
   unbilled, but any delegated hydration/enrichment/retry official call must be
   preceded by a probe reservation, settle in the official-charge transaction,
   and stay within 10,000 units/Pacific day. If settings are absent/malformed,
   official probe-origin work must deny. If spend cannot be measured, the canary
   FAILS. Do not claim zero total official calls.
2. **Zero eligibility/serving changes**: no `search_eligible` mutation, no
   catalog/lifecycle mutation beyond the existing ingestion pipeline, and no
   promotion-gate change.
3. **No cap bypass**: probe ledger counts never exceed 30 total, 20 in a UTC
   day, or 10 in a country/day; no reservation without a ledger row; no
   official dispatch without a probe quota reservation.
4. **Kill switch proves outbound suppression**: with the flag on and the kill
   switch on (or tripped between reservation and fetch), the executor records
   `KILL_SWITCH_ACTIVE`/`KILL_SWITCH_RECHECK` and makes **zero** retrieval
   calls.
5. **Fail-closed behavior**: settings/DB failure denies rather than admits; a
   reservation cannot be replayed with a different evidence version or attempt
   number to exceed the 3-attempt cap; a probe reservation cannot bypass the
   per-key cap when #533 enforcement is on.
6. **Persistence truth**: `newCreators` increments only for persisted,
   was-known-false outcomes; `persisted:false` outcomes never count.

### Yield gates (evaluated at 20 completed probes, then at run end)

- **PASS (existence):** at least **one persisted, verified, net-new qualified
  creator** attributable end-to-end by the 20th completed probe.
- **FAIL:** zero persisted qualified creators after 20 completed probes. Stop;
  do not expand the country or raise caps.
- At run end (up to 30 probes), report the rate. The provisional plan bar is
  **≥1 qualified net-new creator per 20 probes (5%)**; do not treat a single
  success as a stable rate.
- A creator is qualified only when the persisted channel reaches
  `TRADING_CONFIRMED` **and** quality score **≥55** (`queryPerformance.ts`),
  with probe/candidate provenance and a net-new determination. A raw result or
  a channel with `persisted:false` is not a pass.

### Operational gates

- Every probe is one page, cursor null; no continuation requests.
- At most 20 distinct channels ingested per probe; overflow is recorded as
  `INGEST_CAP_APPLIED`.
- Every attempt has one ledger row and a terminal `SUCCESS`/`EMPTY`/`FAILED`/
  `INCONCLUSIVE`/`EXPIRED` outcome; no silent skips.
- Retrieval failure, ingestion failure, and `429` counts are reported; an
  unresolved rate-limit storm is a stop condition, not a pass.
- Probe-bucket usage, per-key projection, settlement failures, and any
  `PROBE_QUOTA_*` denial are reported; an unaccounted official call is a stop
  condition.
- No queue unpause or automation is required or authorized for the canary.

### Decision rule

**Safety failure = FAIL regardless of yield. Zero persisted qualified creators
at 20 probes = FAIL for expansion.** Passing the canary permits a separate
review of a larger tranche; it does **not** authorize automatic promotion,
queue changes, or gate relaxation.

## Preconditions (all required before a canary can start)

1. A resolved InnerTube policy or a separately reviewed official-route
   implementation with budget. The current position prohibits production
   InnerTube use.
2. PRs #533, #546, and #545 merged in that order; migrations 154/155/156 applied
   through the normal runner; no production setting changed by migration.
3. Explicit activation approval for `discovery_probe_enabled`, the canary
   settings, `youtube_probe_official_quota_enabled=true`, and
   `youtube_probe_daily_cap_units=10000`; the flags stay OFF until then.
4. A configured deadline and country allowlist; verify the deadline denial,
   kill-switch suppression, and a denied official call when the probe settings
   are absent before the first probe.
5. A monitoring/read-only evidence path that can prove probe reservation
   coverage, bucket/per-key usage, and no eligibility/serving changes. If
   downstream official spend is not observable, the canary is not runnable.
