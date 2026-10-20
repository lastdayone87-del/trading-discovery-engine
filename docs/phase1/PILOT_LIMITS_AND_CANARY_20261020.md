# Probe pilot limits and canary pass/fail — 2026-10-20

Status: **planning evidence; the pilot is not runnable under the current
InnerTube policy.** No probe has been authorized or executed by this document.
The code limits below are verified against `server/discovery/probeLedger.ts`
and `server/discovery/probeExecutor.ts` on the `phase1-hardening` worktree.

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
| Official route | Disabled | `discovery_probe_allow_official` + executor route check | Executor returns `OFFICIAL_ROUTE_NOT_IMPLEMENTED`; only `youtube-innertube` executes. |
| Pages per probe | 1 | `defaultRetrievePage` passes `cursor: null` | No continuation. Page size constant 20. |
| Channels ingested | 20 per probe | `MAX_CHANNELS_INGESTED_PER_PROBE` | **Per probe, not a total across the run.** Distinct channels are capped before ingestion. |
| Probe retrieval units | 0 | Executor records `units: 0` for its one InnerTube page | The ledger row stores retrieval `units=0`. This is **not** a total-spend claim. |
| Downstream official calls | Not counted by the probe ledger | `defaultIngestChannel` delegates to the existing ingestion pipeline | Hydration can call the official Data API; those calls use the normal quota path and must be measured/reported separately. |

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
sighting does not count.

### Hard safety gates (any failure = FAIL, stop immediately)

1. **Probe retrieval is zero-unit and no unaccounted official call occurs.**
   The probe ledger records zero InnerTube retrieval units. Delegated
   ingestion may make official Data API calls; those must be independently
   visible in the official quota accounting, with no bypass. If that spend
   cannot be measured, the canary FAILS. Do not claim zero total official
   calls.
2. **Zero eligibility/serving changes**: no `search_eligible` mutation, no
   catalog/lifecycle mutation beyond the existing ingestion pipeline, and no
   promotion-gate change.
3. **No cap bypass**: probe ledger counts never exceed 30 total, 20 in a UTC
   day, or 10 in a country/day; no reservation without a ledger row.
4. **Kill switch proves outbound suppression**: with the flag on and the kill
   switch on (or tripped between reservation and fetch), the executor records
   `KILL_SWITCH_ACTIVE`/`KILL_SWITCH_RECHECK` and makes **zero** retrieval
   calls.
5. **Fail-closed behavior**: settings/DB failure denies rather than admits; a
   reservation cannot be replayed with a different evidence version or attempt
   number to exceed the 3-attempt cap.
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
2. PR #531 migrations and code merged and deployed through the approved path.
3. Explicit activation approval for `discovery_probe_enabled` and the canary
   settings; the flag stays OFF until then.
4. A configured deadline and country allowlist; verify the deadline denial and
   kill-switch suppression before the first probe.
5. A monitoring/read-only evidence path that can prove probe retrieval units,
   separately report any downstream official units, and prove no
   eligibility/serving changes. If downstream official spend is not
   observable, the canary is not runnable.
