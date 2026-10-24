# Qualified-creator forecast and units — 2026-10-24

Status: **conditional forecast, not a promise and not an activation request.**
Under the current InnerTube policy there is **no authorized production date**.
Only a persisted, verified, net-new creator attributable to the probe counts.

## Definition and measured baselines

- Code definition: `TRADING_CONFIRMED` **and** quality score **≥55**
  (`server/queryPerformance.ts`).
- Persisted net-new: the ingestion path reports `persisted !== false` and
  `wasKnown === false` (or `isNew === true`); a channel stopped for review or
  not saved is not a creator.
- Measured paid-search baselines from `PHASE1_IMPLEMENTATION_PLAN_20261019.md`
  (996 runs, 173,300 units, 2026-10-02 → 10-18):
  - all runs: **41.9 qualified / 1,000 units** (TRADING_CONFIRMED 81.2 / 1,000);
  - paid YouTube search only: **29.1 qualified / 1,000 units** (lower CI 28.7).
- There is **no probe-stage yield baseline**. A probe retrieval is one
  InnerTube page of up to 20 channels and is unbilled; delegated official work
  is capped separately. The paid per-1,000-unit rate is a comparator, not a
  per-probe yield estimate. The historical free-InnerTube aggregate (4,989
  TRADING_CONFIRMED / 2,217 qualified) is not a per-probe denominator and is
  not used as one here.

## Expected official units per qualified creator

The option-2 decision allows probe-origin official spend, so the forecast must
carry a units estimate, not just a creator count.

- **Measured paid-search comparator:** 1,000 / 29.1 = **≈34 official units per
  qualified creator** for paid search alone (≈24 units on the all-runs basis).
- **Probe stage 1:** `channels.list` 1 + uploads `playlistItems.list` 1 = **2
  units per ingested channel**, plus up to 1 unit for country metadata. At 20
  channels/probe, **≈40 units per probe**.
- **Canary planning value:** at the 5% yield bar (1 qualified creator / 20
  probes), stage-1 cost is **≈800 official units per qualified creator**
  (40 / 0.05). At 3.3–10% the range is **≈400–1,200 units per qualified
  creator**. This is the number to predeclare for the canary.
- **Stage 2:** enrichment can add **up to 101 units per enriched channel**
  (100-unit playlist search + 1-unit video details). It dominates the 10,000/day
  probe bucket, so stage-2 volume must be reported separately. At 20 probes/day,
  stage 1 uses ≈800 units, leaving room for ≈90 stage-2 channels/day.

These are planning values, not observed probe yield. Report actual
`quotaConsumed / relevantNewCreators` from the probe reservation ledger and the
official charge table; do not infer it from the probe ledger's retrieval
`units=0`.

## Scenario arithmetic (not observed results)

Assume independent probes with a constant probability `p` of producing at least
one persisted qualified net-new creator per probe. With 30 probes:

| Per-probe yield `p` | Expected creators / 30 | Probability of zero / 30 | Probability of ≥1 / 30 |
| --- | ---: | ---: | ---: |
| 1 in 20 (5%) | 1.5 | 21.5% | 78.5% |
| 1 in 10 (10%) | 3.0 | 4.2% | 95.8% |
| 1 in 30 (3.3%) | 1.0 | 36.2% | 63.8% |

At the provisional plan bar of **1 per 20 probes**, a 20-probe existence check
has a 35.8% chance of showing zero even if the true rate is exactly 5%. A
30-probe run reduces that to 21.5%, but a single 30-probe canary still cannot
establish the rate precisely. These are planning scenarios, not evidence.

At 5%, the probability of at least one creator reaches about 50% at **14
probes**. At 10% it reaches about 50% at **7 probes**. Do not report those
points as guaranteed dates.

## Dates

Assumptions for the conditional dates:

- PRs #533 and #546 are merged in that order and the stack is deployed through
  the approved path, default OFF; migrations 154/155 are applied by the normal
  runner.
- Probe-origin official work reserves from the 10,000-unit/Pacific-day bucket;
  #533's per-key cap may also be enabled.
- The InnerTube policy is replaced by written authorization, or a separately
  reviewed official-route replacement is approved. Neither exists today.
- Explicit activation approval is given before the first probe, not before this
  report.
- The single-country cap is 10 probes per UTC day; probes execute immediately
  when capacity opens. The total cap is 30.

| Milestone | Conditional earliest | Basis / confidence |
| --- | --- | --- |
| Integration/pilot-stack deployment | **2026-10-27** | Default OFF; requires merge/deploy approval and verified migration state; **low confidence** |
| First authorized probe | **2026-10-28** | Only after policy authorization and explicit activation; **low confidence** because neither exists today |
| 20th probe (existence check) | **2026-10-29** | 10 on UTC 10/28 + 10 on UTC 10/29; earliest possible scheduling |
| 30th probe / tranche data complete | **2026-10-30** | 10 per UTC day for 10/28, 10/29, 10/30 |
| Earliest defensible canary decision | **2026-10-31** | After the 30th probe, persistence audit, and configured observation; **low confidence** |
| Earliest possible first persisted qualified creator | **2026-10-28** | First probe could succeed; probability depends on unmeasured `p` |
| Full 72-hour observation, if required | **2026-10-31 07:00Z** | 72h after a 10/28 07:00Z start; **not code-enforced** (deadline must be configured) |

No date is defensible under the current InnerTube policy. The 2026-10-22
suspended-key retry did not create a probe path. The hard cap remains default
OFF pending separate approval, and the probe bucket is absent until explicitly
enabled.

## What would change the forecast

- A measured probe-yield observation from an authorized canary. Until then,
  report scenarios and label them as such.
- A policy/route change that permits production retrieval.
- Evidence that persistence/verification filters remove most raw hits; the
  forecast counts only persisted, verified, net-new creators, so raw channel
  counts are not a substitute.
- A different country/query mix. The paid baseline is aggregate and is not
  country-specific.

## Reporting rule

Report observed counts with denominators: completed probes, persisted
creators, qualified creators, and the probe/candidate IDs. Report probe-bucket
usage and per-key projection alongside them. Never convert raw returned
channels into creators, never present a scenario probability as an observed
result, and never describe the retrieval `units=0` as zero total official spend.
