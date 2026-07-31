# Trading Community Discovery Engine — Architecture Overview

**Status:** Living architectural specification
**Last updated:** 2026-07-31
**Scope:** Current production architecture, governing principles, system boundaries, and intended evolution

## Purpose and maintenance

This directory is the canonical architectural entry point for the Trading Community Discovery Engine. It explains both **how** the engine works and **why** its boundaries and policies exist. Contributors changing classification, evidence collection, query planning, terminology learning, catalog publication, or lifecycle behavior must update the relevant document in the same change.

The documents are divided by concern:

- [Classification Pipeline](./CLASSIFICATION_PIPELINE.md) — production evidence collection, sufficiency, scoring, and lifecycle decisions.
- [Autonomous Discovery](./AUTONOMOUS_DISCOVERY.md) — query origins, scheduling, selection, execution, and measurement.
- [Learning Pipeline](./LEARNING_PIPELINE.md) — terminology observations, candidate corpus, concepts, evaluation, and governed publication.
- [Roadmap](./ROADMAP.md) — remaining priorities and the desired end state.

Historical phase documents under `docs/` remain useful implementation records, but this section is the living specification of the assembled system.

## Product objective

The engine discovers genuine trading and investing creators and their communities across countries and languages while keeping false positives, quota cost, and operator workload controlled. The system must optimize for ecosystem coverage rather than merely replaying a fixed list of searches.

That objective creates four simultaneous requirements:

1. **High recall:** unfamiliar vocabulary, sparse channels, and new markets must not be silently discarded.
2. **High precision:** `TRADING_CONFIRMED` and `NON_TRADING` are terminal assertions and require affirmative evidence.
3. **Global generalization:** language support cannot depend on endless manual keyword additions.
4. **Governed adaptation:** learned terminology must be source-bound, measurable, reversible, and resistant to feedback loops or manipulation.

## Current top-level architecture

```text
Country scope and quota policy
            │
            ▼
Autonomous query planner ── query library / terminology trials
            │
            ▼
Durable SEARCH_YOUTUBE jobs ── provider pool / cooldown / quota reservation
            │
            ▼
YouTube channel and video observations
            │
            ▼
Unified ingestion pipeline
  1. terminal-state and deduplication check
  2. country validation and exclusion gate
  3. trading evidence collection and decision
  4. uncertain enrichment or confirmed-channel inspection
  5. quality and community analysis
            │
            ├──► operator-visible channel outcomes and diagnostics
            │
            ├──► immutable execution/replay measurements
            │
            └──► terminology and candidate-learning pipelines
```

The planner's Priority 7 boundary also consumes governed multisource query candidates. Trial candidates carry reversible quota controls; proven candidates come only from the active immutable catalog pointer. Both retain concept and source provenance in the durable query record, while curated country atoms stay available as controls and last-known-good fallback.

Priority 8 adds a shared language capability boundary ahead of governed query
admission. Country, language, script, audience locale, traded market, query
locale, and provider region are distinct facts. Unicode field observations,
code-switching and transliteration flags, capability disposition, reason codes,
policy versions, and a deterministic checksum are persisted in organic query
provenance. Unsupported or contradictory metadata abstains instead of borrowing
English or country-derived certainty.

### Authoritative versus shadow paths

The production evidence-based classifier remains authoritative. The adaptive classifier, candidate corpus, bounded semantic candidate adjudication, concept graph, offline evaluation, and catalog systems contain advanced learning primitives, but several operate in shadow, proposal-only, or governed publication modes. A shadow result must never mutate a production decision merely because it exists.

This separation is deliberate:

- production behavior stays deterministic and auditable;
- new features can be evaluated against immutable outcomes;
- promotion requires evidence rather than architectural optimism;
- failures in learning observers cannot delay ingestion;
- rollback remains possible through versioned policies and catalog pointers.

## Key architectural principles

### 1. Open-world reasoning

The engine operates in an unbounded, multilingual domain. Failure to recognize a term is evidence about **system coverage**, not evidence that the channel is non-trading.

Consequences:

- no positive match is not equivalent to `NON_TRADING`;
- missing providers and missing metadata must remain observable;
- ambiguous cases route to enrichment or review;
- terminal negative decisions require affirmative negative evidence;
- unsupported languages are a coverage state, not a negative label.

### 2. Evidence sufficiency precedes classification

A decision must describe whether the available material is:

- `MISSING` — no classifiable metadata is present;
- `INSUFFICIENT` — some metadata exists, but it cannot support a terminal conclusion;
- `SUFFICIENT` — enough context or explicit evidence exists to evaluate, although the result may still be ambiguous.

Sufficiency is separate from polarity. A rich channel can have sufficient but conflicting evidence; a sparse channel can have a very strong explicit platform link; a provider outage can degrade confidence without creating negative evidence.

### 3. Provider availability is part of the evidence

Every provider is expected to report one of:

- `AVAILABLE` — it ran over applicable input;
- `NOT_APPLICABLE` — the required input was not supplied;
- `UNAVAILABLE` — a configured capability, credential, or service is absent;
- `FAILED` — an applicable provider attempted work and failed.

`UNAVAILABLE` and `FAILED` are operational facts. Neither is a semantic negative. This prevents quota exhaustion, missing API keys, or transient errors from becoming false classifications.

### 4. Terminal labels are affirmative claims

- `TRADING_CONFIRMED` means corroborated positive evidence meets a high-precision policy.
- `NON_TRADING` means explicit negative-domain, adjacent-finance, hype, or other affirmative negative evidence meets policy.
- `UNCERTAIN` means the system abstains because evidence is missing, insufficient, degraded, ambiguous, or below terminal thresholds.

Abstention is a supported outcome, not a classifier failure.

### 5. Multilingual semantics must generalize beyond vocabularies

Static terms remain valuable as high-precision, explainable features and cold-start anchors. They must not define the full boundary of trading relevance. The long-term classifier must understand meaning across languages, scripts, loanwords, transliterations, and code-switching using field-aware multilingual semantic models calibrated on reviewed examples.

### 6. Learning must be source-bound and governed

A learned term or concept must retain:

- exact source span and document identity;
- observation and discovery lineage;
- creator/entity independence evidence;
- classifier, extractor, and policy versions;
- performance attribution and uncertainty;
- lifecycle history and rollback path.

AI may classify bounded observed candidates. It must not silently invent the vocabulary it later evaluates.

### 7. Query intelligence is adaptive, not unconstrained

The current engine uses cooldowns, intent rotation, performance measurement, exploration, and UCB-style selection. Learned queries enter controlled trials. Future adaptation should expand the search space organically, but always under quota, causality, precision, and lifecycle controls.

### 8. Measurement and production decisions are immutable

Execution outcomes, review corrections, shadow decisions, and experiment assignments must remain replayable. New policy versions reinterpret or compare history; they do not rewrite it. This is essential for calibration, regression analysis, and safe promotion.

## Current architectural strengths

- One unified ingestion path serves manual and autonomous discoveries.
- Country exclusions are evaluated before expensive classification and community work.
- Evidence providers are isolated from one another.
- Priority 0 now distinguishes provider coverage and evidence sufficiency.
- `UNCERTAIN` has a durable enrichment and review lifecycle.
- Query execution is separated from planning through durable jobs.
- Query performance and terminology performance are persisted.
- Manual-search observations do not automatically train autonomous behavior.
- Terminology has decay, diversity, trial, promotion, and demotion concepts.
- New corpus, concept, evaluation, catalog, replay, and portfolio primitives are versioned and governed.

## Current architectural limitations

- Production positive evidence is still dominated by static vocabularies and fixed domain lists.
- Country selection commonly stands in for true per-field language detection.
- Recent video descriptions are not preserved as a fully field-aligned semantic corpus at the classifier boundary.
- Playlists, transcripts, external-site content, and visual branding are underused.
- Discord evidence is generally unavailable before the trading gate.
- Learned terminology is admitted only after channels are already confirmed, creating selection bias.
- Curated fallback query generation remains country-anchored; governed organic
  queries use the global capability model, but provider-wide migration and
  representative global calibration are still incomplete.
- The adaptive classifier and newer catalog stack are not the authoritative production path.
- Query reward emphasizes novelty more strongly than calibrated, quality-adjusted trading yield.

These limitations define the roadmap rather than invalidating the current safety boundaries.

## Decision ownership

| Concern | Current authority | Non-authoritative/supporting systems |
|---|---|---|
| Country acceptance | Country validation and configured exclusion policy | Country inference evidence and replay reports |
| Trading relevance | Evidence-based production classifier v1.4 | Adaptive classifier shadow, offline evaluation |
| Uncertain lifecycle | Unified ingestion and enrichment lifecycle | Human review supplies ground truth |
| Query selection | Query Intelligence query library and selector | Terminology trials and portfolio measurement |
| Learned terminology | Phase F terminology lifecycle | Candidate corpus and concept graph proposals |
| Serving catalogs | Explicit reviewed/approved/published catalog pointer | Candidate catalogs and offline experiments |

## Change checklist for contributors

Before changing an authoritative path, answer:

1. Does the change preserve open-world reasoning?
2. Can missing or failed evidence be distinguished from negative evidence?
3. Is the decision and all contributing evidence versioned and explainable?
4. Does it alter terminal-state precision, uncertain volume, quota, or review load?
5. Has it been replayed on human-reviewed multilingual examples?
6. Is learning lineage preserved and protected against correlated sources?
7. Is promotion explicit, measurable, and reversible?
8. Have these architecture documents been updated?
