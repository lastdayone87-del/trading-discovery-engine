# Offline Admission V2 proof of concept

This proof of concept tests one hypothesis only: whether existing immutable
creator-level evidence can withhold clearly non-trading creators while retaining
genuine trading creators. It has no production, serving, scheduling, or automatic
promotion authority.

## Input boundary

Run the evaluator against an existing sealed decision-evaluation dataset:

```bash
npm run admission:v2-poc -- <sealed-dataset-uuid>
```

The command opens a PostgreSQL `READ ONLY` transaction and reads only the sealed
dataset's `TEST` examples, their pinned production diagnostic, the matching
immutable creator-focus snapshot, and the matching immutable evidence-coverage
snapshot. It does not run migrations, seed defaults, call a provider, or write a
report back to the database.

The report excludes examples that lack creator-focus or coverage history and
reports the resulting historical-evidence eligibility rate. An incomplete
historical evidence plane causes `INSUFFICIENT_EVIDENCE`; it cannot be hidden by
evaluating only the available subset.

## Counterfactual decisions

- `WITHHOLD` requires sufficient, supported, recent, independently corroborated
  evidence, alternative-focus mass of at least 0.8, trading-focus mass below 0.2,
  and an existing creator-focus `NON_TRADING` proposal.
- `ADMIT_CONFIRMED` requires the same evidence gates, trading-focus mass and lower
  confidence bound of at least 0.7, alternative-focus mass below 0.6, and an
  existing creator-focus `TRADING_CONFIRMED` proposal.
- `ADMIT_REVIEW` requires a plausible trading-focus mass of at least 0.35 after
  the evidence gates pass.
- Missing, insufficient, unsupported-language, stale, or dependent evidence
  always produces `DEFER_INVESTIGATION`, never `WITHHOLD`.

These rules reuse the current creator-focus hypothesis taxonomy and conservative
V4 boundaries. They are versioned as an offline POC policy and do not modify the
existing Release 1 admission policy.

## Report semantics

The report contains each proposed decision, reason codes, human-readable
reasoning, creator-focus metrics, evidence coverage, production baseline, ground
truth, and segment. Aggregate metrics use the sealed cohort's logged inclusion
probabilities:

- **False-positive reduction** is the weighted share of ground-truth non-trading
  examples missed by the legacy production status that V2 would withhold.
- **Genuine-creator recall** counts a genuine creator as retained unless V2 would
  withhold it. Confirmation is reported separately.
- **Projected enrichment reduction** uses legacy `UNCERTAIN` and `NEEDS_REVIEW`
  examples as an unresolved-work proxy and counts those V2 would withhold.
- **Projected review-workload reduction** uses the same conservative unresolved
  proxy and compares it with V2's `ADMIT_REVIEW` decisions. It is not represented
  as observed job or review execution.

The central hypothesis is `INSUFFICIENT_EVIDENCE` unless both genuine and legacy-
missed non-trading cohorts have an effective sample size of at least 30 and at
least 90% of the sealed test examples have the required immutable creator
evidence. It is `SUPPORTED` only when propensity-weighted retained-creator recall
is at least 95% and false-positive reduction is positive.

`inputChecksum` and `outputChecksum` bind the dataset identity, immutable inputs,
policy version, exclusions, decisions, and metrics so repeated evaluation of the
same sealed history is replay-verifiable.
