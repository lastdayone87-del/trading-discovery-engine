# Probe-origin official quota allocation (option 2) — 2026-10-24

PR: [#546](https://github.com/lastdayone87-del/trading-discovery-engine/pull/546)
(stacked on [#533](https://github.com/lastdayone87-del/trading-discovery-engine/pull/533))
· Status: **default OFF, not deployed, not activated, migrations 154/155 not
applied to production.**

## Decision

Probe-origin work **may spend official YouTube quota**. It is not required to
be zero-official-unit. Instead, every official call attributable to a probe
must reserve from an independent, durable probe bucket before dispatch and
settle that reservation in the same transaction as the official charge.

This replaces the earlier "zero official units" rule. The InnerTube retrieval
page itself remains unbilled and is still recorded as `units=0`; that ledger
field is a retrieval fact, **not** a total-spend claim. Delegated hydration,
queued enrichment, retries, recovery, and any other official path are capped
and accounted.

## Exact allocation

| Setting | Default | Rule |
| --- | --- | --- |
| `youtube_probe_official_quota_enabled` | absent/false | Only the exact string `true` enables probe-origin official spend. Absent, false, malformed, or unreadable settings fail closed. |
| `youtube_probe_daily_cap_units` | 0 (disabled) | Integer, `100 <= cap <= min(10% of effective daily budget, 20,000)`. Requested production value: **10,000**. |

At the current effective budget of 35 keys × 10,000 = **350,000 units/Pacific
day**, 10,000 is **2.86%** of the budget and **3.17%** of #533's 315,000-unit
hard-cap ceiling (35 × 9,000). The validation maximum at this budget is
20,000.

The bucket is per **Pacific day**, the same day boundary as #533. It is not a
per-key bucket and it is not shared with ordinary enrichment. When #533
enforcement is ON, a probe lease also counts toward that key's 9,000-unit
projection; both controls are checked before a single lease is inserted, so the
same units are not double-counted.

## Atomicity and coverage

Admission holds two advisory locks in one transaction:

1. the shared `youtube-key-cap:<day>:<fingerprint>` lock used by #533's shadow
   and enforced writers; then
2. the global `youtube-probe-quota:<day>` bucket lock.

The key lock is required even while #533 enforcement is OFF: probe leases live
in `youtube_key_cap_shadow_leases` with `allocation='PROBE'`, and a concurrent
shadow/enforced projection must see them. The global lock serializes the 10,000
bucket across all keys and workers. The lease is inserted only if the probe
projection and, when enforced, the key projection both admit it. A duplicate
operation ID is idempotent for the same key/units and rejected for a different
key/units.

Settlement removes the lease and increments `youtube_probe_quota_usage` in the
**same transaction** as `incrementQuota`. A crash cannot lose or double-count a
charge. A reservation is released only when dispatch provably did not happen
(e.g. admission or pre-dispatch failure); an ambiguous fetch/HTTP failure keeps
the lease until the Pacific reset, which can under-admit but cannot overspend.

### Path coverage

| Path | Fence |
| --- | --- |
| Direct probe discover / hydration | `youtubeFetch` reserves before the official request when the origin is probe |
| Queued enrichment | Durable `quota_origin` provenance is carried on channels/jobs (migration 154); the job's `youtubeFetch` reserves from the probe bucket |
| Retries | Every retry is a new dispatch and must reserve again; a retry does not reuse a released or settled lease |
| Recovery after restart | Origin is durable in the database; a recovered job still resolves as probe and reserves |
| Concurrent jobs | Shared key lock + global bucket lock + unique `(quota_day, operation_id)`; concurrent reservations cannot overrun either control |
| Key failover | Each dispatched key reserves; the reservation is attached to that response and settles with it |
| Non-probe work | No probe reservation; uses the ordinary path, so probe spend cannot starve it and ordinary spend cannot consume the probe bucket |

`isProbeOfficialYouTubeQuotaOrigin()` is resolved from durable provenance, not
from a process-local flag. A probe discovery is **not** human-reviewed or
promoted solely because of its origin; the existing qualification, persistence,
and review gates are unchanged. Existing enrichment is not starved: the probe
bucket is additive and isolated, and the only shared limit is #533's per-key
9,000 cap, which applies to all spend equally.

## Absent-settings behavior and migration additivity

- With both probe settings absent, `resolveProbeQuotaConfig()` returns disabled;
  `youtubeFetch` makes **no probe reservation, no probe lease, and no probe
  usage write**. Probe-origin official calls fail closed instead of spending
  uncapped.
- Migration **154** adds durable `quota_origin` provenance; migration **155**
  adds the probe usage table and the `allocation` column/default on the lease
  table. Both are additive and do not insert settings, backfill spend, or
  change existing rows' behavior. Migration 155 requires 148/151's lease table;
  it does not replace it.
- Applying 154/155 with settings absent changes no runtime behavior. #546
  cannot merge before #533; the combined migrations are 154/155 on top of the
  already-merged 146–153 lineage.

## Enforcement switch-on and shadow drain

The #533 hard cap and the #546 probe cap are independent. To turn on the
**hard cap** safely after this stack is deployed default-OFF:

1. Confirm migrations 148/151/154/155 are applied by the normal runner, and
   confirm `youtube_key_daily_cap_enforced` is absent/false.
2. Let shadow mode run for at least one full drain window: the lease TTL
   (120 s) plus the provider timeout, and preferably one full Pacific day, so
   no in-flight shadow observation can be mistaken for an enforced lease.
3. Avoid mixed cached-OFF/enforced traffic during the switch. The shared
   key/day lock makes mixed modes safe, but the drain removes the observational
   ambiguity entirely.
4. Set `youtube_key_daily_cap_enforced=true`; verify the first reservations
   settle and that no key exceeds 9,000 projected units.
5. Roll back by setting the value to `false` (or deleting the row). Existing
   leases remain until reset but are excluded once expired; the shadow path
   resumes.

To turn on the **probe allocation**, after 154/155 are applied and before any
probe-origin official work: set `youtube_probe_official_quota_enabled=true` and
`youtube_probe_daily_cap_units=10000`, then verify `getProbeQuotaStatus()`
reports the expected day, cap, and zero usage. Absent or malformed values must
deny. Probe activation itself still requires the separate InnerTube/policy and
operator approvals; this setting only caps spend after those approvals.

## Expected official units per qualified creator

- Paid-search baseline (996 runs, 173,300 units, 2026-10-02 → 10-18): **29.1
  qualified creators / 1,000 units**, or **≈34 official units per qualified
  creator** for paid search alone. This is a measured comparator, not a probe
  yield.
- Probe-origin stage-1 hydration costs **2 units per ingested channel**
  (`channels.list` 1 + uploads `playlistItems.list` 1), plus up to 1 unit for
  country metadata. At 20 channels/probe that is **≈40 units per probe**.
- At the canary yield bar of 1 qualified creator per 20 probes (5%), the
  expected stage-1 cost is **≈800 official units per qualified creator**
  (40 / 0.05); at 3.3–10% the planning range is **≈400–1,200**.
- Stage-2 enrichment can add **up to 101 units per enriched channel** (100-unit
  playlist search + 1-unit video details). The 10,000/day probe bucket leaves
  room for roughly 90 such channels after stage-1 hydration at 20 probes/day,
  but stage-2 must be monitored because it dominates the bucket.
