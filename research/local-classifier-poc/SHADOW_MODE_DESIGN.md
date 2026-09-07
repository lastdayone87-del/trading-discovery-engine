# Shadow-mode design (PROPOSAL ONLY — not implemented, not approved)

Measure the hybrid policy on live traffic without letting it decide anything.

## Design

- Shadow worker (separate job type or sidecar of enrichment, default OFF,
  env-gated) runs the local classifier + threshold router over the SAME live
  `RawChannelInput` the production path uses.
- Persists a shadow verdict row per channel: `{channel_id, classifier_label,
  p_trading, band_decision, thresholds_version, model_version, observed_at}`.
  New append-only table or existing diagnostics envelope — schema decision
  deferred to implementation approval; no schema change in this proposal.
- Production outcome proceeds exactly as today (LLM path authoritative).
- Comparison job (offline, scheduled): joins shadow verdicts vs realized
  outcomes (human decisions, discord validation, later trading_status) and
  emits: agreement rate, abstention rate, would-be precision at band,
  would-be LLM-call reduction, calibration bins, per-language slices.

## Metrics to measure (all read-only derivations)

1. Shadow-vs-human agreement (where humans decide).
2. Shadow-vs-realized-outcome agreement (discord/trading_status at +30d).
3. Abstention rate and its stability week-over-week.
4. Would-be precision at the fitted band vs realized precision.
5. Would-be LLM-call reduction % (cost/load impact).
6. Calibration: binned p_trading vs realized positive rate.
7. Latency p50/p95 of local inference in the worker environment.
8. Drift signals: band mass shift, feature-coverage drop, language-mix shift.

## Production changes this would eventually require (NOT done)

- Env-gated shadow worker + kill switch (default OFF).
- Shadow verdict persistence (append-only; TBD table vs diagnostics field).
- Offline comparison job + dashboard panel (read-only queries).
- Thresholds artifact hosting + versioning.
- Explicitly NOT required: crawler/retry/scoring/schema changes for the
  serving path; provider key changes; backlog mutation.

## Validation plan

1. Dry-run on historical inputs (replay, zero live impact).
2. Shadow on a fixed cohort → compare vs humans → gate promotion on
   pre-registered precision/coverage bars.
3. Kill-switch drill; rollback = env flag only.
