# Live Thompson Evaluation — frozen plan (v1)

Status: PLAN ONLY. No traffic has run under this plan. Changing anything below after activation voids this plan and requires a new version.

## Experiment identity

- `experimentId`: `live-thompson-eval-v1` (never a `benchmark-prereg-*` identity; benchmark attribution cannot collide).
- Arms: CONTROL (legacy UCB1) vs THOMPSON, single-arm treatment.
- Assignment: `treatmentBasisPoints: 5000` → ~50/50 by deterministic bucket on the cycle-built opportunity key (checksum of scheduler/country/attempt plus `:fallback`/`:legacy` suffix; see `runAutonomousDiscoveryCycle`). Same key always draws the same arm; retries carry new attempt keys and therefore draw anew (same convention as the frozen benchmark replay path) — recorded per attempt, never double-counted.
- Priors/weights: Thompson `alpha0=1, beta0=1`; contextual weights unused (no CONTEXTUAL arm).
- Activation: `app_settings.live_selection_experiment` JSON (exact schema below). Absent/invalid → legacy UCB1, byte-identical behavior.

```json
{
  "selection": {
    "experimentId": "live-thompson-eval-v1",
    "enabledArms": ["THOMPSON"],
    "treatmentBasisPoints": 5000,
    "thompsonPrior": { "alpha0": 1, "beta0": 1 },
    "contextualWeights": { "value": 0.5, "exploration": 0.35, "cost": 0.1 }
  }
}
```

## Duration and attribution window

- Run: **14 days** minimum (7 days is underpowered — see analysis).
- Attribution window: validations credited up to **7 days post-run**. Measured lag proxy (channel create→VALIDATED-update, upper bound, n=364): median 16h, p90 4.8d, p99 6.2d — 7 days covers ≥95% with margin. Analysis opens only after the window closes on the final run (14d run + 7d close ≈ 21 days to decision).

## Primary metric and decision rule (prespecified)

- Metric: validated, newly first-owned invites per 1,000 quota units, Thompson vs UCB1. Numerator excludes raw finds, duplicates, and already-owned invites (symmetric ownership registry); denominator is summed `quota_used` per arm.
- Minimum evidence: ≥30 validated invites per arm with the window closed.
- Estimator (country-stratified non-inferiority, prespecified): for each country c, arm rates r̂(c) = validated invites / quota units (×1000), with Poisson standard errors se(c) = sqrt(r̂(c)/units(c)) × 1000. Overall arm rate = inverse-variance weighted mean across countries with non-degenerate data; overall SE = 1/sqrt(Σ 1/se(c)²). Non-inferiority holds iff the upper bound of the one-sided 95% Wald interval on (control − Thompson) is below 20% of the pooled control rate. Countries with zero validated invites on both arms contribute no information and are reported, not imputed. Residual cross-arm cooldown interference is disclosed per §Interference, never adjusted away.
- **Adopt Thompson iff:** one-sided 95% Wald interval on the Thompson-minus-control rate difference excludes differences worse than **−20% of the control rate** (non-inferiority margin: 20% relative), AND no material operational/quality regressions.
- **Otherwise:** `INCONCLUSIVE`, retain UCB1. Failure to detect a difference is not equivalence.
- No efficacy peeking: no early stop, no rule changes on interim performance.

## Safety stops (ops signals only)

Pause via `query_intelligence_paused` kill switch (plus config removal for instant legacy revert) on: error rate ≥3× trailing-7d baseline, daily quota ≥90% consumed before 20:00 UTC, provider outage >1h, or any production incident. Paused periods are reported, never backfilled. Stops never trigger on observed efficacy.

## Interference statement

Shared per-country pools/cooldowns affect both arms; per-opportunity randomization spreads it evenly in expectation; analysis stratifies by country. Residual asymmetry is disclosed, not adjusted. Country-level randomization was rejected (16 heterogeneous units).
