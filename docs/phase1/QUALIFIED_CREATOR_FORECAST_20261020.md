# Qualified-creator forecast and dates — 2026-10-20

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
- There is **no probe-stage yield baseline**. A probe is one InnerTube page of
  up to 20 channels at 0 official units, not a 100-unit search call. The paid
  per-1,000-unit rate therefore cannot be converted directly into a per-probe
  rate. The historical free-InnerTube aggregate (4,989 TRADING_CONFIRMED /
  2,217 qualified, 0 quota) is not a per-probe denominator and is not used as
  one here.

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

- PR #531 is merged and deployed through the approved path.
- The InnerTube policy is replaced by written authorization, or a separately
  reviewed official-route implementation is approved. Neither exists today.
- Explicit activation approval is given at **2026-10-21 07:00Z**
  (2026-10-21 00:00 America/Los_Angeles).
- The single-country cap is 10 probes per UTC day; probes execute immediately
  when capacity opens. The total cap is 30.

| Milestone | Conditional earliest | Basis / confidence |
| --- | --- | --- |
| First authorized probe | **2026-10-21 07:00Z** | Immediately after the assumed approval; **low confidence**, because approvals and prerequisites do not exist |
| 20th probe (existence check) | **2026-10-22 00:00Z** | 10 on UTC 10/21 + 10 on UTC 10/22; earliest possible scheduling |
| 30th probe / canary data complete | **2026-10-23 00:00Z** | 10 per UTC day for 10/21, 10/22, 10/23 |
| Earliest defensible canary decision | **2026-10-23** (review after the 30th probe) | Requires the safety gates and persistence audit; **low confidence** until a probe baseline exists |
| Earliest possible first persisted qualified creator | **2026-10-21** | First probe could succeed; probability is low at any plausible `p` |
| Full 72-hour observation, if required | **2026-10-24 07:00Z** | 72h after the assumed start; **not code-enforced** (deadline must be configured) |

No date is defensible under the current InnerTube policy. The suspended-key
retry date (2026-10-22) does not create a probe path: the probe executor rejects
the official route, and the hard cap remains default OFF pending separate
approval.

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
creators, qualified creators, and the probe/candidate IDs. Never convert raw
returned channels into creators, and never present a scenario probability as an
observed result.
