# Stage 6 shadow discovery machinery

Status: shadow-only. No discovery serving authority changes.

This stage adds the two contracts identified by the Stage 4–6 gap audit without replacing `server/queryPlanner.ts`.

## Creator frontier

`server/discovery/creatorFrontier.ts` projects durable channel-level priority from creator signals:

- upload recency
- recent upload vitality
- evidence sufficiency
- authority signal
- community signal
- uncertainty / exploration value

The projection is intentionally non-serving (`servingAuthority: false`). It does not reorder queries, skip candidates, change review eligibility, or trigger/avoid enrichment.

## Outcome feedback

`server/discovery/outcomeFeedback.ts` defines how admitted, withheld, and human-reviewed outcomes may later be evaluated as retrieval feedback.

Historical observational outcomes are not eligible for policy learning by default. An observation must come from randomized allocation or carry a valid recorded allocation probability before it can be treated as learning-eligible. This protects against promoting selection bias into discovery policy.

## Recall boundary

A keyword/exploration lane remains a required part of any future serving design. Creator-frontier scoring must not become the only discovery path. Unknown and uncertain creators retain explicit exploration value.

## Promotion boundary

Nothing in this stage is production authority. Before any Stage 6 serving canary:

1. collect shadow creator-frontier projections alongside real discovery outcomes;
2. record allocation lane and propensity/randomization metadata prospectively;
3. compare creator yield, human acceptance, false-negative/recovery behavior, country/language coverage, and duplicate search spend against the legacy query allocation;
4. define a sealed promotion dataset and thresholds;
5. preserve an independently governed exploration/recall lane and kill switch.

Stage 1 remains the prerequisite for downstream authority described in the roadmap. Stage 6 shadow measurement may proceed independently because it does not alter serving behavior.
