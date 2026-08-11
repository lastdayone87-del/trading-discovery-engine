# Stage 4–6 dormant implementation gap audit

Status: architecture audit only. No serving authority changes.

## Preconditions

Stage 1 remains the promotion prerequisite for downstream production authority. Stage 2 dashboard canary infrastructure is already present and intentionally dormant until a sealed Stage 1 dataset produces the required promotion evidence.

## Stage 4 — Review eligibility canary

### Already present

- `server/reviewEligibility/policy.ts` defines `review-eligibility-v2-shadow-1` with `servingAuthority: false`.
- Eligibility is fail-closed: terminal decisions are not reviewable, country-policy failures are terminal, operational/provider/language gaps defer rather than force review, and `ELIGIBLE` requires an unresolved classification plus a plausible trading hypothesis and sufficient independent evidence.
- `server/release5/rollout.ts` already declares `REVIEW_ELIGIBILITY` as an independently governed Release-5 capability.
- Review serving has its own setting (`release5_review_serving_mode`), rollout projection, promotion-gate requirement, deterministic canary assignment, kill-switch control, and review-materialization observability.

### Gap to close before activation

Do not create a second review architecture. The remaining work is to pin the actual queue/materialization boundary to the existing Release-5 assignment contract with source-contract tests and a dormant readiness gate equivalent to Stage 2. Until that exists and Stage 3 has held, review serving must remain OFF.

## Stage 5 — Expensive-work / Discord gating

### Already present

- Existing pipeline/enrichment/job infrastructure already separates durable work from classification state.
- Release-5 rollout infrastructure provides the governance pattern needed for canary assignment and kill switches.

### Gap to close

Add an optional efficiency policy only after Stage 4 is proven. It may defer Discord or other expensive acquisition for Admission outcomes equivalent to `WITHHELD_NO_PLAUSIBLE_HYPOTHESIS`, but it must never be required for dashboard correctness and must preserve a legacy/recall lane. The first implementation should be shadow measurement: estimate saved work, false-defer rate, later-label reversals, and recovery behavior without skipping production work.

## Stage 6 — Discovery intake redesign

### Already present

- `server/queryPlanner.ts` is already creator-oriented in its objectives (for example, finding active futures/equity/options creators rather than generic matching documents).
- It already has exploration/exploitation/cold-start modes, cooldowns, intent diversity, learned terminology, organic candidates, retrieval specificity, country-aware atoms, and bounded query construction.

### Gap to close

Do not replace the query planner. Add two missing layers around it:

1. **Creator frontier** — durable channel-level frontier state that prioritizes creator identities using recency, vitality, evidence sufficiency, authority/community signals, and uncertainty rather than repeatedly spending search on isolated keyword hits.
2. **Outcome feedback** — feed admitted/withheld/human-reviewed outcomes back into query allocation so queries and retrieval lanes are evaluated by the quality of creators they produce. Preserve a keyword/exploration lane for recall and require randomized or propensity-recorded allocation before using outcomes for policy promotion.

## Safe implementation order

1. Continue Stage 1 prospective 30/30 evidence collection and seal the dataset.
2. Stage 2 dashboard CANARY after the sealed Stage 1 promotion gate.
3. Stage 3 dashboard ACTIVE only after canary metrics hold.
4. Add/verify dormant Stage 4 queue-materialization contract and readiness tooling; activate REVIEW_ELIGIBILITY canary only after Stage 3 stability.
5. Build Stage 5 shadow savings/counterfactual measurement; later canary expensive-work deferral with a kill switch and recall lane.
6. Build Stage 6 creator-frontier and outcome-feedback machinery in shadow, then promote independently after measured retrieval-quality gains.

## Non-goals

- No activation of dashboard, review, Discord, enrichment, or discovery authority.
- No lowering of Stage 1 evidence requirements.
- No historical lineage fabrication or label backfill.
- No channel-name/channel-id special cases.
- No replacement of existing Release-5 governance or query-planner infrastructure when reusable contracts already exist.
