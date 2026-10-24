# Adaptive creator-derived pilot — question, metrics, and activation plan

Date: 2026-10-24 · PR: [#545](https://github.com/lastdayone87-del/trading-discovery-engine/pull/545)
· Branch: `feat/adaptive-country-pilot` · Status: **default OFF, not activated,
not deployed, no live treatment data.** This document is a predeclared
evaluation plan, not evidence that the treatment works.

## What the 14-day 50/50 pilot learns beyond probes

The probe pilot answers a **supply** question: can bounded InnerTube retrieval
find candidate creators at an acceptable retrieval rate? It does not answer
whether an already-verified creator can be converted into a **new relevant
creator in a target country**, or whether that conversion beats the existing
country-native vocabulary path.

The adaptive pilot randomizes whole **country-Pacific-days** 50/50:

- **CONTROL** runs the existing country-native materialization path unchanged.
- **TREATMENT** additionally receives bounded `CREATOR_DERIVED` follow-up
  proposals built from verified quality creators and governed country
  vocabulary evidence.

The 14-day window is long enough to observe 14 country-days per country. At
50/50 that is about 7 treatment and 7 control country-days per country, or
roughly 28 treatment and 28 control country-days across four countries. That
supports a **directional** read of a large effect; it is not powered for a
small effect or a per-country estimate. The unit of inference is the
country-day assignment, not an individual search result.

The pilot does **not** test probe retrieval, InnerTube policy, the hard cap, or
frontier authorization. Those remain separate gates. A read-only replay of
historical runs is a **baseline balance/variance check only**; historical runs
never received the treatment, so replay differences are not causal evidence.

## Predeclared questions

**Primary:** in treatment country-days, does creator-derived materialization
increase persisted, genuinely new, relevant creators per run without a
material increase in duplicates or a reliability/quota regression?

**Secondary:**

1. Does treatment improve novelty without inflating duplicate sightings?
2. What official quota is consumed per relevant new creator?
3. Does treatment remain reliable under the existing provider/cap controls?

## Predeclared metrics

All metrics come from `computeAdaptivePilotMetrics()` over the immutable
country-day assignment ledger and the latest observation revision per run.
No metric requires additional provider calls.

| Metric | Definition | Why it matters |
| --- | --- | --- |
| **Genuinely new relevant creators** | `relevantNewCreators`: persisted channels with `wasKnown=false` (or `isNew=true`), `TRADING_CONFIRMED`, quality score ≥55 | The only creator count that can justify expansion |
| **Novelty rate** | `newCreators / rawResults` | Share of returned results that are new, not repeat sightings |
| **Duplicate rate** | `knownCreators / distinctCreators` | Whether treatment mostly rediscovers the catalog |
| **Relevant creators per run** | `relevantNewCreators / runs` | Primary yield comparison |
| **Reliability** | `1 - providerFailures / runs` | Whether treatment remains operable under provider pressure |
| **Quota use** | `quotaConsumed` and `quotaConsumed / relevantNewCreators` | Efficiency versus the control arm |

A creator that is returned but not persisted, a review-routed row, or a repeat
sighting is not a new creator. Assignment is recorded before generation and is
immutable for the country-day; a later setting change cannot flip an arm.

## Cheapest early read

The cheapest read is the **existing read-only metrics query**, run after three
complete Pacific days, using only the assignment ledger and run observations.
It costs **zero provider units** and must not trigger extra discovery.

Predeclare the read before activation:

- **Day 3 read:** compute the primary and secondary metrics. Stop the pilot if
  treatment reliability is below 0.80, if the duplicate rate is more than 10
  percentage points worse than control, or if quota per relevant creator is
  more than 1.5× control. Continue only if treatment relevant creators/run is
  at least equal to control and duplicates are not worse.
- **Day 7 interim:** repeat the same read; do not change arms or reuse the
  day-3 sample as independent evidence.
- **Day 14 primary:** evaluate the full window. No daily peeking, no
  optional-stopping adjustment, and no arm switching.

The day-3/7 reads are guardrails, not proof. A small sample can reverse; only
the predeclared day-14 read supports a recommendation.

## Predeclared success rule

Recommend expansion only if **all** of the following hold at day 14:

1. Treatment relevant creators/run is at least **1.25× control**.
2. Treatment duplicate rate is **not higher** than control by more than 5
   percentage points.
3. Treatment novelty rate is **not lower** than control.
4. Treatment reliability is **at least 0.90** and not more than 5 percentage
   points below control.
5. Quota per relevant new creator is **not more than 1.25× control**.

Any safety or reliability stop fails regardless of yield. A null result keeps
the pilot off; it does not authorize a larger tranche.

## Activation plan (requires explicit approval)

Prerequisites, in order:

1. Merge #533 (hard cap), #546 (probe allocation), then #545. #546 is stacked
   on #533 and must not merge independently. Apply additive migrations
   **154, 155, 156** only through the normal migration runner.
2. Verify the no-op state first: with all pilot/probe/hard-cap settings absent,
   there are no new writes, no probe reservations, no adaptive proposals, and
   no enforcement. Migration application alone must change no behavior.
3. Set `frontier_allocation_enabled=true`. This is **required** for
   `CREATOR_DERIVED` proposals to be allocated; without it the pilot can
   generate evidence but cannot execute treatment.
4. Set the eligible-country scope explicitly:
   `query_intelligence_discovery_scope='SELECTED_COUNTRIES'` and
   `query_intelligence_selected_countries` =
   `["United States","United Kingdom","Australia","Canada"]`.
   These four supported, non-dormant countries have the vocabulary and creator
   supply needed for a first read. Do not include dormant countries, and do not
   use `GLOBAL` for the pilot. Confirm hard-excluded countries remain excluded.
5. Set `adaptive_discovery_pilot_enabled=true`,
   `adaptive_discovery_pilot_treatment_percent=50`, and
   `adaptive_discovery_pilot_seed=adaptive-pilot-v1`.
6. Verify the first assignments are recorded before generation, that CONTROL
   countries produce no `CREATOR_DERIVED` proposals, and that treatment
   proposals expire at their country-day window end.
7. Run the day-3, day-7, and day-14 read-only metrics. The replay script is a
   baseline check only and is not activation evidence.

Do **not** combine this activation with probe activation, hard-cap
enforcement, queue changes, or a production deployment. Those are separate
approvals. Rollback is immediate: set
`adaptive_discovery_pilot_enabled=false`; existing assignments remain audit
records, and unexpired treatment proposals stop being allocatable through the
existing pilot gate.
