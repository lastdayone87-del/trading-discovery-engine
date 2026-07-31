# Learning Pipeline

**Status:** Current production, shadow, and governed-publication specification
**Related:** [Architecture Overview](./ARCHITECTURE_OVERVIEW.md) · [Autonomous Discovery](./AUTONOMOUS_DISCOVERY.md) · [Roadmap](./ROADMAP.md)

## Purpose

The learning pipeline turns reviewed and high-confidence discoveries into reusable knowledge without allowing unbounded self-training. It must expand coverage while preserving source provenance, independence, measurement integrity, moderation, and rollback.

## Current learning systems

The repository contains three overlapping generations of learning infrastructure.

### 1. Extracted vocabulary

After an autonomous channel is `TRADING_CONFIRMED` and reaches the quality threshold, the ingestion path can extract:

- a fixed list of known instruments through deterministic matching;
- localized terminology, instruments, phrases, and formats through Gemini when configured.

Results are saved as extracted vocabulary and terminology observations. Manual-search channels are excluded unless a human approval later establishes independent provenance.

This path actively feeds current query planning, but its deterministic extraction is narrow and its Gemini path can propose free-form strings.

### 2. Continuous terminology intelligence

Canonical terms retain:

- normalized country-scoped identity;
- language and script metadata;
- aliases;
- append-only observations;
- creator and community provenance;
- evidence decay;
- query performance attribution;
- lifecycle events and score snapshots.

The lifecycle includes:

```text
CANDIDATE
  → OBSERVED
  → MULTI_CREATOR_VALIDATED
  → SEARCH_TRIAL
  → PROVEN_SEARCH_TERM
  → DEMOTED (when repeated yield is poor)
```

Brands are retained as observations but cannot automatically become search terms. Search eligibility requires diversity and performance rather than occurrence count alone.

This system is the active learned-terminology input to the planner.

### 3. Evidence-derived candidate and concept architecture

Later phases add a more rigorous path:

```text
eligible source artifacts
      ↓
immutable retained corpus documents
      ↓
deterministic Unicode 1–5 gram candidate spans
      ↓
feature scoring and anomaly detection
      ↓
bounded AI adjudication for ambiguous observed spans
      ↓
concept-resolution proposals and moderation
      ↓
offline counterfactual evaluation
      ↓
candidate catalogs and lifecycle states
      ↓
review, approval, publication, active catalog pointer
```

This newer stack addresses important weaknesses:

- candidates are exact observed spans rather than invented vocabulary;
- offsets, content hashes, extractor versions, and lineage are retained;
- correlated creator clusters and temporal bursts can be detected;
- AI receives a closed label set and cannot rewrite the literal candidate;
- concepts are separated from language-specific surfaces;
- catalogs are immutable and explicitly published;
- serving pointers are versioned and rollback-capable.

Several of these components remain shadow, proposal-only, offline, or not yet wired into the authoritative query planner and classifier.

## Learning admission boundary

A channel does not automatically train the engine merely because it was discovered.

Current autonomous admission generally requires:

1. country acceptance;
2. production `TRADING_CONFIRMED`;
3. quality score at or above the configured threshold;
4. non-manual lineage, or explicit human approval followed by enrichment.

This protects the engine from obvious contamination, but it also creates selection bias: false-negative or uncertain channels cannot teach new vocabulary until review corrects or confirms them. Priority 0 improves preservation and reviewability but does not remove this admission boundary.

## Provenance and independence

A valid learned observation should answer:

- Which source document contained the term?
- What exact span and offsets were observed?
- Which channel, video, playlist, site, or community produced it?
- Was the source autonomous, manual-unapproved, or human-approved?
- Which query and retrieval lane discovered the source?
- Is this creator independent from other supporting creators?
- Does it share a website, Discord, owner, text template, or affiliate funnel?
- Which extractor, classifier, and policy versions acted on it?

Raw occurrence volume is not independent evidence. Ten copied channels or one coordinated affiliate network must not qualify a concept as if ten unrelated educators used it.

## Bounded use of AI

The intended AI role is semantic adjudication, not uncontrolled vocabulary authorship.

Safe AI input:

- a literal source-bound span;
- bounded local context;
- source facts and language/script hints;
- a closed taxonomy;
- an explicit abstention option.

Safe AI output:

- trading, non-trading, ambiguous, spam, brand, person, generic, or other;
- concept class;
- confidence and reason codes;
- no modified or newly invented candidate surface.

The legacy free-form Gemini extraction path remains a migration target because it does not fully meet this principle.

## Concepts and surfaces

The desired knowledge model separates:

- **Concept:** country-neutral semantic identity such as an instrument, strategy, platform, market, educator, or format.
- **Surface:** a language-, script-, locale-, and time-specific expression of the concept.
- **Sense:** an approved or ambiguous mapping between a surface and a concept.
- **Relation:** broader, narrower, translated, synonymous, associated, market-specific, or other governed connection.
- **Policy edge:** where and how a concept surface may be used for classification or retrieval.

This model supports multilingual aliases and homonyms without pretending normalized strings are universal identity.

## Catalog governance

Learned knowledge must not enter production simply because it scored well once.

The catalog path provides:

1. immutable candidate evaluation results;
2. reviewed candidate catalogs;
3. lifecycle states such as `CANDIDATE`, `ELIGIBLE`, `PROVEN`, `STALE`, `SATURATED`, `HARMFUL`, and `INVALID`;
4. staging with policy and checksum;
5. explicit approval;
6. publication to a country/locale/lane pointer;
7. optimistic pointer versioning;
8. rollback through another publication event;
9. last-known-good curated fallback.

The current staging policy enforces a very high curated floor. That is a safety mechanism during rollout, not the desired permanent ceiling on organic learning.

## Adaptive classifier shadow

The adaptive classifier reuses the immutable production decision and may add only governed terminology/catalog and high-confidence evidence-graph corroboration. It is intentionally conservative:

- observed or proposed terminology alone is excluded;
- ambiguous senses are excluded;
- graph evidence is corroboration-only;
- multiple corroborated concepts are required;
- a production `NON_TRADING` result vetoes shadow confirmation;
- execution and persistence are detached from production ingestion;
- human review labels support later precision and recall comparison.

Priority 0 changes the production baseline so missing evidence is less likely to become an erroneous negative veto, but the adaptive system remains shadow-only until a separately approved promotion policy exists.

## Performance attribution

A learned term is valuable only if controlled usage improves discovery outcomes. Measurement should consider:

- confirmed new trading creators;
- country and language precision;
- creator quality;
- community value;
- false positives and review load;
- duplicates and saturation;
- retrieval lane and ordering;
- quota cost;
- incremental yield relative to a curated control;
- confidence intervals and delayed review outcomes.

The current terminology path records detailed funnel fields, but its primary decayed-yield calculation is still closer to `new creators / distinct results` than the complete objective above. Promotion can therefore overvalue novelty that is not relevant or cost-effective.

## Desired continuous learning loop

```text
Multisource observations
  channels · videos · playlists · transcripts · sites · relationships
                         │
                         ▼
Immutable source corpus and entity resolution
                         │
                         ▼
Deterministic candidate spans and semantic entities
                         │
                         ▼
Multilingual bounded classification + human moderation
                         │
                         ▼
Concept graph with localized surfaces and ambiguity
                         │
                         ▼
Offline replay and counterfactual evaluation
                         │
                         ▼
Quota-limited randomized production trials
                         │
                         ▼
Cost-, quality-, and precision-aware outcome attribution
                         │
                         ▼
Versioned lifecycle and governed catalog publication
                         │
             ┌───────────┴───────────┐
             ▼                       ▼
Semantic classification       Adaptive query planning
             │                       │
             └──────── outcomes ─────┘
```

The loop continuously expands what the engine can recognize and retrieve while retaining curated controls, abstention, moderation, and rollback.

## Non-negotiable safeguards

- No learning from an unapproved manual-search lineage.
- No invented term without an exact source-bound candidate.
- No promotion based only on correlated occurrence volume.
- No direct production activation from an AI assertion.
- No hidden mutation of historical outcomes.
- No catalog publication without review, policy version, checksum, and rollback path.
- No optimization solely for raw or novel result count.
- No unsupported language treated as negative evidence.
- No adaptive classifier promotion without multilingual precision/recall evidence and review-cost analysis.
