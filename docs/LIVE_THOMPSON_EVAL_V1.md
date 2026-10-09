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
- Attribution window: validations credited up to **7 days post-run**, covering the measured p95 (5.1d) with margin. Analysis opens only after the window closes on the final run (14d run + 7d close ≈ 21 days to decision).

## Reproducible power basis (measured 2026-10-09, read-only)

- Numerator join (re-runnable verbatim): `channels` (`discord_discovery_status='VALIDATED'`, non-null `discord_invite`) → normalize code exactly as migration `138_discord_invite_registry.sql` (lowercase, strip query/fragment and known invite-host prefixes) → `discord_invite_registry` on `(canonical_code, first_channel_id)` for first-ownership → `r.first_seen_at >= now() - interval '14 days'`. Dedupe rule: earliest `first_seen_at` wins per code (registry primary key enforces one row per code by construction). Eligibility filters: VALIDATED status, non-null invite, first-owned match, 14-day window. Denominator: completed `query_runs` in the same window (attributed per run) and summed `quota_used`.
- Measured: **308 validated first-owned invites / 14d** (~22/day); lag (first_seen → channel updated_at, upper-bound proxy, n=308): **median 14.3h, p90 4.7d, p95 5.1d, p99 5.5d**. Directly measured: join counts, lag percentiles. Proxy (stated, not proof): channel `updated_at` overstates true validation latency, so the window is conservative.
- Power at 50/50, 14-day run (~329 runs/arm, ~154 invites/arm at 0.47/run): one-sided 95% Wald on the rate difference at a 20% relative margin gives **≈54% power** — below 80%. Reaching 80% needs a ~28-day run at the same margin, or a 30% margin at 14 days (≈84%). The 30/arm floor itself is comfortably met (~154 expected); the binding constraint is power, not the floor.
- If this join ever stops reproducing (schema drift, empty result with live traffic present), treat the power basis as void and re-measure before activation — do not fall back to proxy counts.
- Reproducibility artifacts: `scripts/live-eval-power.sql` (exact read-only join above; re-ran green against production: 309 on 2026-10-09, +1 vs the 10-09 basis as live traffic accrues) and `scripts/live-eval-power.mjs` (pure power arithmetic; `node` it to verify the 54%/84%/154/28-day figures from the stated inputs).

## Primary metric and decision rule (prespecified)

- Metric: validated, newly first-owned invites per 1,000 quota units, Thompson vs UCB1. Implemented by `attributeFirstOwnedInvites` + `summarizeArmOutcomes` (`server/liveThompsonAnalysis.ts`): attribution runs across every supplied row FIRST (including legacy/pre-experiment rows, so a live rediscovery of an already-owned code cannot count), then only first-seen rows of the exact experiment identity contribute invites; denominators (runs, quota) come from the scoped run ledger — including runs with zero first-owned invites — never from invite rows. Raw finds, duplicates, and already-owned invites are excluded symmetrically for both arms.
- Minimum evidence: ≥30 validated invites per arm with the window closed.
- Estimator (country-stratified non-inferiority, prespecified): for each country c, arm rates r̂(c) = validated invites / quota units (×1000), with Poisson standard errors se(c) = sqrt(r̂(c)/units(c)) × 1000. Overall arm rate = inverse-variance weighted mean across countries with non-degenerate data; overall SE = 1/sqrt(Σ 1/se(c)²). Non-inferiority holds iff the upper bound of the one-sided 95% Wald interval on (control − Thompson) is below 20% of the pooled control rate. Countries with zero validated invites on both arms contribute no information and are reported, not imputed. Residual cross-arm cooldown interference is disclosed per §Interference, never adjusted away.
- **Adopt Thompson iff:** one-sided 95% Wald interval on the Thompson-minus-control rate difference excludes differences worse than **−20% of the control rate** (non-inferiority margin: 20% relative), AND no material operational/quality regressions.
- **Otherwise:** `INCONCLUSIVE`, retain UCB1. Failure to detect a difference is not equivalence.
- No efficacy peeking: no early stop, no rule changes on interim performance.

## Safety stops (ops signals only)

Pause via `query_intelligence_paused` kill switch (plus config removal for instant legacy revert) on: error rate ≥3× trailing-7d baseline, daily quota ≥90% consumed before 20:00 UTC, provider outage >1h, or any production incident. Paused periods are reported, never backfilled. Stops never trigger on observed efficacy.

## Interference statement

Shared per-country pools/cooldowns affect both arms; per-opportunity randomization spreads it evenly in expectation; analysis stratifies by country. Residual asymmetry is disclosed, not adjusted. Country-level randomization was rejected (16 heterogeneous units).
