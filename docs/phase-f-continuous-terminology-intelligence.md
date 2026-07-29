# Phase F: Continuous Terminology Intelligence

## Architecture

Phase F adds an evidence-driven terminology subsystem alongside the existing query,
queue, worker, quota, duplicate-detection, and review systems. The old extracted
vocabulary tables remain readable for API compatibility and migration history, but
new learning is written to canonical terms and an append-only observation ledger.

The flow is:

1. Normalize an observed term with Unicode NFKC and whitespace/case folding.
2. Resolve it to a country-scoped canonical term and retain aliases separately.
3. Append source provenance from channel names, video titles, descriptions,
   enrichment, or human approval. Human approval has a stronger evidence weight.
4. Recompute a versioned, time-decayed score from independent creators and
   community fingerprints.
5. Promote only after configured creator/community diversity gates. Branding is
   evidence-only and cannot automatically become search eligible.
6. Admit search trials through the existing Phase B retrieval-atom planner and
   attribute query outcomes back to the canonical term.
7. Promote productive trials or demote stale/low-yield terms without deleting
   observations, execution records, or lifecycle history.

## Data model and durability

Migration `012_continuous_terminology_intelligence.sql` creates:

- `canonical_trading_terms`: identity, locale, eligibility, trust, and lifecycle.
- `trading_term_aliases`: abbreviations, spellings, transliterations, shorthand,
  and regional variants mapped to one canonical concept.
- `terminology_observations`: append-only production and human-review provenance.
- `terminology_performance`: term-specific outcomes, lanes, quota, and yield.
- `terminology_lifecycle_events`: immutable promotion/demotion explanations.
- `terminology_score_snapshots`: reproducible scoring version and configuration.

Existing flat vocabulary is backfilled as non-search-eligible canonical candidates.
It must earn eligibility under Phase F policy; occurrence totals alone are never
sufficient.

## Feedback-loop protection

Search trials require at least three distinct creators, two distinct communities,
and sufficient decayed evidence by default. Planner exploration remains controlled,
while performance uses net-new creators rather than repeated raw results. A
90-day configurable half-life lets current production evidence outweigh history.
Append-only snapshots enable later offline replay and unbiased policy evaluation.

## Query Intelligence and explainability

The Phase B planner still builds compact queries from typed retrieval atoms.
Eligible canonical terms are ranked by decayed production yield ahead of legacy
learned vocabulary. Query metadata records the canonical ID, lifecycle, score, and
selection rationale. Phase A query funnel metrics remain unchanged and are copied
into term-level attribution after the normal query update succeeds.

## Operational impact and risk

Observation writes add one canonical upsert, one ledger insert, and a lifecycle
refresh. Indexed country/lifecycle, term/date, and creator paths bound online reads.
Dashboard aggregation is read-only and can move to materialized summaries if the
ledger becomes large. The primary remaining risks are homonyms across languages,
shared-community fingerprints, and extraction-model noise; alias moderation,
language detection, and periodic offline replay are recommended next safeguards.
