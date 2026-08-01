# Phase 17 — Shared utility contract and value-of-information evidence acquisition

## Scope and authority

Phase 17 replaces the implicit “one generic enrichment, then another, then
review” policy with a governed action decision. The first production action
registry intentionally contains only capabilities the engine already executes:

- channel and recent-video metadata (`101` provider units);
- deeper video descriptions and playlist corroboration (`202` provider units);
- human review (no provider units, one review-capacity unit).

The controller cannot confirm or reject a channel. Acquired evidence always
returns through the existing evidence engine, staged corroboration,
contradiction, and lifecycle policy.

## Shared utility and hard constraints

Actions expose a utility vector rather than inventing subsystem-specific scores:

- expected decision resolution;
- confirmation-recall value;
- precision protection;
- coverage and information gain;
- provider, review, latency, and operational-risk costs.

Hard constraints are evaluated before utility. Country policy, terminal
precision, governance, prerequisites, provider/case quota, latency deadlines,
and review capacity cannot be compensated for by a high recall estimate. An
infeasible action has no utility score.

The initial resolution estimates are conservative policy priors, not learned
facts. Immutable action outcomes expose resolved-confirmation yield, failures,
provider cost, and latency. Stage 1 datasets and controlled assignments are the
only permitted source for future fitted estimates.

## Decision behavior

The controller derives typed gaps from sufficiency, sparse metadata, provider
degradation, semantic abstention, unsupported language, and corroboration
stages. It then ranks only registered actions that can address at least one gap.

Examples:

- sparse or missing metadata selects the bounded channel/recent-video action;
- a semantic candidate with missing corroboration can select the deeper
  video/playlist action directly, avoiding an uninformative intermediate pass;
- completed enrichment, exhausted quota, or inapplicable prerequisites fail
  closed to human review;
- provider failure remains an operational outcome and never negative evidence.

## Rollout modes and compatibility

- `OFF` (default): the legacy action is applied and no controller decision is
  persisted.
- `SHADOW`: the value-of-information selection and utilities are persisted, but
  the legacy action is still applied.
- `CANARY`: deterministic assignment applies the selected action only to the
  configured basis-point cohort; the complementary control keeps the legacy
  action. Allocation defaults to zero. No terminal-classifier policy changes.

Every decision records its evidence gaps, all action assessments, selected,
legacy, and applied actions, reason codes, policy/utility versions, and checksum.
Canary propensity, randomization value, and assignment are immutable.
Every worker attempt appends success, failure, or skip outcome with actual cost,
latency, and resulting status. Retry outcomes never rewrite earlier attempts.

## Expected production impact and measurements

The primary expected improvement is resolved decisions per provider unit. A
direct deep-corroboration action can avoid spending `101` units on a first pass
that cannot resolve a known corroboration gap. Sparse cases retain the cheaper
first action, protecting quota.

Canary promotion requires comparison with the fixed enrichment control on:

- terminal-positive precision and false-positive bounds;
- resolved trading confirmations per provider unit;
- false-negative and abstention rates;
- review referrals per candidate;
- mean and tail evidence latency;
- action failure and skip rates;
- country, language, script, and evidence-band slices.

Until Stage 1 produces sufficient propensity-aware samples, the priors must not
self-update and `CANARY` allocation must remain bounded and reversible.

## Operational safety and rollback

The migration is additive, decisions/outcomes are immutable, and the default is
off. Rollback changes `voi_evidence_controller_mode` to `OFF`; queued enrichment
jobs remain compatible because they still use the existing `ENRICH_CHANNEL`
type and enrichment-stage payload. Controller persistence failure falls back to
the legacy action. Global quota reservation in the worker remains authoritative
even after the planning-time quota constraint passes.
