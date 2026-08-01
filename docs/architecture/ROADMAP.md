# Architecture Roadmap

**Status:** Prioritized long-term direction after completed Priority 0
**Related:** [Architecture Overview](./ARCHITECTURE_OVERVIEW.md) · [Classification Pipeline](./CLASSIFICATION_PIPELINE.md) · [Autonomous Discovery](./AUTONOMOUS_DISCOVERY.md) · [Learning Pipeline](./LEARNING_PIPELINE.md)

## Roadmap policy

This roadmap records architectural intent, not a promise to activate every existing subsystem. Each production change requires offline replay, observable rollout, explicit ownership, and rollback. Priorities may be decomposed into smaller delivery phases, but their safety properties must not be partially implemented.

## Completed foundation — Priority 0: immediate false-negative safety

**Status:** Implemented in evidence/decision/scoring engine v1.4.

### Problem

The previous classifier could infer `NON_TRADING` from zero recognized positive evidence even when it had zero negative evidence. Provider failures, sparse metadata, and vocabulary gaps were indistinguishable at the scoring boundary.

### Completed correction

- provider availability states are explicit;
- evidence sufficiency is explicit;
- sparse and degraded cases are diagnosable;
- low keyword coverage no longer generates a negative video penalty;
- terminal negative decisions require affirmative negative evidence;
- missing and insufficient cases route to `UNCERTAIN`;
- reviewed false-negative and provider-outage replays protect the boundary.

### Exit criteria retained for future changes

- provider failure never changes semantic polarity;
- zero recognized positive evidence alone never yields `NON_TRADING`;
- positive confirmation thresholds remain high precision;
- missing/insufficient/degraded distinctions remain in diagnostics;
- replay coverage includes multilingual reviewed false negatives.

## Completed — Priority 1: staged, field-aware classification

**Status:** Implemented in evidence/decision/scoring engine v2.0.

### Objective

Replace one monolithic additive decision with stages that separately evaluate input quality, high-recall relevance, corroboration, contradiction, and lifecycle routing.

### Target stages

1. **Evidence availability and sufficiency** — retain the Priority 0 contract and improve calibration.
2. **High-recall semantic candidate detection** — determine whether the creator plausibly belongs to trading/investing without requiring seeded terminology.
3. **High-precision corroboration** — require agreement across creator identity, repeated content, methodology, instruments, platforms, or trusted resources.
4. **Contradiction analysis** — identify genuinely dominant unrelated, adjacent-finance, or hype behavior with field and recency context.
5. **Lifecycle policy** — confirm, reject, enrich, or review without conflating model score with workflow state.

### Field-aware representation

Do not flatten all content into one undifferentiated string. Preserve:

- channel title;
- channel bio sentences;
- each video title, description, publication time, and content type;
- playlist names and descriptions;
- external-link labels, domains, and resolved entity types;
- declared country and independently detected languages;
- transcript or caption excerpts when budget allows;
- visual evidence with source and model provenance.

### Design rationale

A term in a channel title is not equivalent to an incidental phrase in one old description. Repetition across independent recent videos is stronger than repetition inside one field. Contradiction must account for source, frequency, dominance, and recency.

### Acceptance criteria

- no terminal decision without adequate stage-specific evidence;
- explicit abstention at each semantic model boundary;
- per-field provenance in diagnostics;
- no regression in `TRADING_CONFIRMED` precision;
- material reduction in reviewed false-negative rate;
- bounded review-rate increase with quota/cost measurement.

### Implemented boundary

The production decision now emits five versioned stage reports. Availability can
abstain independently of semantics; candidate detection uses semantic and
methodology evidence; corroboration requires repeated-video evidence, multiple
providers, or multiple evidence dimensions; contradiction requires affirmative,
dominant negative evidence; and lifecycle policy maps the stage outcome to
confirm, reject, enrich, or review. The arithmetic score remains available for
compatibility and diagnostics but can no longer create a terminal state when the
corresponding stages abstain.

The input contract now preserves structured videos (including publication time
and content type), playlists, resolved external links, detected languages,
transcript excerpts, and visual model provenance. Existing legacy arrays remain
accepted while ingestion migrates to richer inputs. Machine-readable field
references are carried in evidence provenance and stage diagnostics.

## In progress — Priority 2: multilingual semantic understanding and calibration

### Objective

Make semantic meaning, not static vocabulary coverage, the primary generalizer across languages and countries.

### Architecture

Use a cost-tiered approach:

1. multilingual embeddings or a compact classifier for high-recall candidate detection;
2. a multilingual cross-encoder or structured LLM adjudicator for ambiguous cases;
3. deterministic high-precision vocabulary and entity features as explainable corroboration;
4. human review for unresolved or policy-sensitive cases.

Static vocabularies remain useful cold-start and precision features. They cease to define the universe of acceptable language.

### Language model requirements

- language and script detection per field, not solely from country;
- code-switching and loanword handling;
- transliteration and regional spelling variants;
- unsupported-language abstention rather than English fallback certainty;
- structured distinction among active trading, investing education, financial news, personal finance, hype, and unrelated content;
- versioned model, prompt, feature, and calibration artifacts.

### Evaluation corpus

Continuously sample human-reviewed cases across:

- supported and frontier languages;
- large and small creators;
- sparse and rich metadata;
- trading, investing, news, personal finance, hype, and unrelated domains;
- provider-outage scenarios;
- corrected false negatives and false positives;
- code-switched and multilingual channels.

Report precision, recall, calibration, abstention, and review rate per country, language, script, evidence band, and provider-availability state.

### Acceptance criteria

- statistically defensible recall improvement on time-split reviewed data;
- no material false-positive increase, including confidence bounds;
- calibrated or explicitly non-probabilistic score semantics;
- predictable cost and latency budgets;
- safe fallback to deterministic evidence plus `UNCERTAIN` during model unavailability.

### Implemented foundation

Evidence engine v2.1 introduces the production boundary for this priority. A
cost-tiered multilingual semantic provider now returns a closed domain taxonomy,
per-field language/script observations, source-field citations, reason codes,
explicit unsupported-language abstention, and versioned model, prompt, feature,
and calibration metadata. A compact model handles candidate detection and an
opt-in adjudicator handles low-confidence or ambiguous cases. Semantic evidence
can generalize beyond configured vocabulary, but remains subject to the existing
independent-corroboration and contradiction stages; it cannot confirm or reject a
creator by itself. Deterministic providers therefore remain high-precision
anchors and the entire path safely degrades to `UNCERTAIN` when unavailable.

The checked-in bootstrap calibration is intentionally conservative and is not a
claim of calibrated probability. Completing Priority 2 still requires a
representative, time-split reviewed corpus, fitted calibration artifacts,
confidence intervals by language/country/script/evidence band, latency and cost
budgets, and an observed rollout that meets the acceptance criteria above.

## Priority 7: organic, multisource query expansion

**Status:** Implemented production serving boundary; source adapters continue to expand.

### Objective

Allow discovery knowledge to expand beyond the original country seed ontology without uncontrolled AI-authored search.

### Candidate sources

- approved concept surfaces from confirmed/reviewed creators;
- recent video and playlist topic clusters;
- transcript keyphrases;
- external websites, broker/platform entities, and community links;
- creator collaborations, featured channels, and playlist ownership graphs;
- multilingual semantic neighbors and translations;
- emerging instruments, venues, educators, and market formats;
- explicit undercovered cells in the country/language/market/strategy matrix.

### Trial architecture

1. Construct source-bound query candidates.
2. Validate language, script, safety, and retrieval shape.
3. Evaluate against immutable historical evidence where possible.
4. Assign a small quota-limited randomized trial against a curated control.
5. Record assignment propensity and full funnel outcomes.
6. Promote, retain, mark stale/saturated/harmful, or invalidate through lifecycle policy.
7. Publish only governed candidates to a versioned serving catalog.

### Reward function

Optimize for a cost- and quality-aware objective, not raw novelty:

```text
confirmed new trading creators
+ quality-adjusted community value
+ coverage gain
- false positives
- wrong-country results
- review burden
- duplicate/saturation cost
- quota and provider cost
```

### Acceptance criteria

- every query atom has origin and concept identity;
- trial traffic is capped and reversible;
- performance is attributable against a control;
- harmful and saturated candidates automatically leave active allocation;
- curated fallback remains available.

### Implemented boundary

The planner now accepts source-bound candidates from the approved multisource taxonomy and admits only independently corroborated candidates whose language, script, safety, and retrieval-shape checks were recorded under the pinned Priority 7 policy. `SEARCH_TRIAL` candidates require explicit experiment, assignment-cap, and quota-cap provenance and remain anchored to a curated local control. `PROVEN` candidates may run as compact standalone queries only after publication in the immutable catalog currently pinned for the search scope.

Every emitted organic query records candidate and concept identities, exact source references, independent source identities, language/script/locale, lifecycle, validation policy, trial or catalog pin, and a deterministic provenance checksum. The production loader fails closed for older catalog entries without that contract. Existing terminology and country-seed behavior is unchanged and remains the curated fallback. This creates the serving seam for Priority 8 locale/script policy and Priority 10's unified concept catalog without putting the mutable graph on the online path.

## Priority 8: global language, script, and market model

**Status:** Production foundation implemented; broader provider and corpus coverage continues.

### Objective

Remove hard-coded country-anchor and script restrictions while preserving retrieval safety.

### Required model changes

Separate:

- creator country;
- declared platform country;
- content language and script;
- target audience locale;
- market/instrument region;
- query locale;
- platform/provider region.

Replace static script rejection with:

- Unicode-aware normalization;
- language/script detection and confidence;
- transliteration and alias support;
- locale-aware query validation;
- small controlled trials for new scripts;
- result-based country and semantic precision feedback.

Learned concepts should be eligible for several query shapes:

- standalone local surface;
- translated or transliterated surface;
- concept plus local instrument/market;
- concept plus educator/content format;
- relationship or playlist frontier expansion.

They should not always require an original Tier 1 country anchor.

### Acceptance criteria

- Arabic, Cyrillic, Devanagari, Hangul, and other scripts can enter governed trials;
- unsupported scripts never silently fall back to English reasoning;
- country and language evidence remain independent and auditable;
- new country enablement does not require a complete manual vocabulary pack.

### Implemented foundation

The shared `global-language-capability-v1` boundary now separates creator and
platform country, content language/script, audience and query locale,
market/instrument regions, and provider region. It performs deterministic NFKC
normalization, BCP 47 canonicalization, Unicode script observation, and explicit
multiscript/transliteration reporting. Every decision carries reason codes,
policy/normalization versions, field observations, and a stable provenance
checksum. Unknown language/script and declared/detected mismatches abstain.

Priority 7 organic admission and planning now consume this shared decision.
Arabic, Cyrillic, Devanagari, Hangul, and other Unicode scripts can enter only
through independently corroborated, quota-capped controlled trials or a pinned
published catalog; legacy curated country queries retain their existing safety
behavior. This removes static non-Latin rejection from the governed path without
weakening the last-known-good country-scoped fallback and creates the compact
decision seam intended for Priority 10's serving catalog.

## Priority 10: unify concepts, catalogs, classification, and planning

**Status:** Production governed knowledge-plane foundation implemented; consumer canaries and legacy-store retirement remain rollout work.

### Objective

Make one governed knowledge plane serve both semantic classification and adaptive retrieval.

### Desired end state

```text
Immutable multisource evidence
          ↓
Candidate spans and entities
          ↓
Concept graph + localized surfaces + senses
          ↓
Offline evaluation and controlled trials
          ↓
Versioned governed catalogs
      ┌───┴──────────────────┐
      ▼                      ▼
Classifier features     Query planner atoms
      │                      │
      └──── measured outcomes┘
                 ↓
        Lifecycle transitions
```

### Serving requirements

- immutable catalog versions;
- country/locale/lane policy scopes;
- explicit review and approval;
- atomic pointer changes;
- last-known-good curated fallback;
- pinned feature/catalog versions in every decision and query run;
- no online dependency on an unbounded mutable graph;
- deterministic reconstruction from published entries;
- rollback and comparison tooling.

### Migration strategy

1. Reconcile legacy extracted vocabulary and terminology with concept surfaces.
2. Make active catalog reads available in shadow beside the current planner and classifier.
3. Compare decision and query allocations with immutable outcomes.
4. Promote one bounded country/locale/lane canary.
5. Increase learned allocation only when precision, recall, cost, and review guardrails pass.
6. Retire duplicate legacy stores only after replay and rollback proof.

### Acceptance criteria

- one concept identity connects classification and discovery evidence;
- no ungoverned learned term reaches production;
- catalog behavior is deterministic, pinned, and reversible;
- production improves coverage without losing precision or operational resilience.

### Implemented foundation

The `governed-knowledge-v1` contract is the common publication boundary for classification, discovery, semantics, language capability, and terminology. Versioned concepts contain localized surfaces, approved senses, explicit lane scopes, and immutable source provenance. Mutable output enters only as append-only contributions and cannot be served until review creates a checksummed publication. Atomic scoped pointers retain publish and rollback history, while consumer records pin the artifact and policy for exact replay. Existing serving catalogs remain compatible fallback paths and the mutable graph never enters an online path.

## Cross-cutting work required by every priority

- immutable replay and human-review ground truth;
- provider cost, latency, failure, and availability telemetry;
- per-country/language precision and recall;
- confidence intervals for promotions and regressions;
- source/entity independence controls;
- anomaly and coordinated-manipulation detection;
- explicit review workload budgets;
- documentation updates in `docs/architecture/`.

## Active implementation — Phase 16 decision evaluation control plane

The post-roadmap implementation begins with the measurement dependency shared by
all later adaptive work. Phase 16 adds immutable cohort assignments with known
inclusion propensity, ground-truth lineage, sealed evaluation datasets,
propensity-weighted benchmarking and calibration diagnostics, and evidence-based
promotion gates. These records are observational and cannot activate production.
See [the Phase 16 decision record](../phase-16-decision-evaluation-control-plane.md).

## Active implementation — Phase 17 intelligent evidence acquisition

Phase 17 introduces the shared utility/hard-constraint contract and a
value-of-information controller over the existing bounded enrichment actions.
It derives typed evidence gaps, compares expected resolution against provider,
review, latency, quota, and risk cost, and records immutable selections and
outcomes. `OFF` and `SHADOW` preserve the legacy action; a bounded `CANARY` may
choose only a registered action and cannot bypass staged classification. See
[the Phase 17 decision record](../phase-17-value-of-information-evidence.md).

## What not to do

- Do not fix global recall by continually appending static keywords.
- Do not treat a missing model/provider as a negative classification.
- Do not let an LLM generate and activate its own vocabulary without source spans and trials.
- Do not optimize query selection only for new-channel count.
- Do not merge country, language, audience, and traded market into one inferred label.
- Do not activate the mutable graph directly on the online path.
- Do not automatically promote a shadow classifier because aggregate accuracy looks higher.
- Do not remove curated controls until learned catalogs have proven rollback-safe behavior.
