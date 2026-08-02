# Production trading-classification recall architecture review

**Date:** 2026-08-01  
**Scope:** production decision path for every supported country, language, and
market  
**Decision:** architecture and rollout plan only; no classifier behavior or
threshold is changed by this review

## 1. Executive conclusion

The engine is not losing confidence in one place. Genuine channels can pass
through a sequence of lossy transformations and then must satisfy two only
partly aligned decision systems:

1. collection truncates or ignores useful documents;
2. deterministic providers reduce many observations to one aggregate item;
3. language coverage is selected mainly from the declared country;
4. weights are hand-authored and correlated emissions are added as if they were
   independent;
5. `50 + positive - negative` is presented as confidence although it is not a
   calibrated probability;
6. heuristic score rules may say “confirmed,” but a separate staged gate can
   overwrite that result unless it recognizes a semantic candidate and two
   attributable source families; and
7. governed learning generally runs after the production decision, in shadow or
   behind a disabled flag.

The largest immediate source of **Needs Review / Uncertain despite substantial
evidence** is the corroboration gate. Several providers inspect the same rich
channel and video corpus, but omit field-level provenance. Their evidence raises
the arithmetic score while contributing zero attributable source families, so
the final gate caps the score at 79 and changes the status to `UNCERTAIN`.
Country-knowledge evidence has the same provenance problem. Conversely, the
video provider aggregates all matching videos into category-level items. That
preserves weight but makes document independence difficult to establish
correctly.

The right correction is **not** to lower a global threshold. Replace the dual
heuristic decision with a provenance-first, concept-based evidence model and a
calibrated selective classifier. Aggregate correlated observations by concept
and source family, model support and contradiction separately, calibrate by
coverage cohort, and confirm only when the lower confidence bound satisfies a
precision guardrail. Route specific information gaps to bounded enrichment.
This improves recall by making genuine independent evidence count, rather than
by weakening the acceptance boundary.

## 2. Review method and limits

This is a static architecture review of the executed production path, providers,
knowledge packs, staged decision, adaptive path, diagnostics, and evaluation
controls. Existing tests and architecture documents were used to verify intended
invariants. No channel-specific exception, country-specific threshold, or new
term is proposed.

This repository does not contain a representative, time-split, production
ground-truth dataset joined to complete decision traces. Therefore the review
can identify deterministic confidence-loss mechanisms exactly, but cannot
honestly attribute a percentage of current misses to each mechanism. That
measurement gap is itself a Priority 0 finding.

### Executed path

```text
ingested channel snapshot
  -> legacy-array normalization
  -> country-selected static knowledge context
  -> seven parallel providers
  -> aggregate EvidenceItem[] and coarse sufficiency
  -> staged availability/candidate/corroboration/contradiction gates
  -> additive weighted heuristic and status rules
  -> staged lifecycle veto/override
  -> optional governed classifier after the immutable production decision
  -> stored diagnostics, review, and corrective-learning proposal
```

Country inference/exclusion is upstream and intentionally distinct from trading
relevance. It must remain distinct: geographic certainty must neither increase
nor decrease the probability that a creator is trading-focused.

## 3. Where confidence is lost

### F1 — Rich evidence without attributable provenance cannot corroborate (P0)

**Current behavior.** `MultilingualContextProvider` scans the complete context
and can emit very-high-reliability methodology evidence, but its provenance has
no `fields`. `CountryKnowledgeProvider` also emits country/language matches
without field references. The staged classifier derives fallback fields only
for display, while its independence calculation uses only
`item.provenance.fields`. These strong items can push positive weight over a
confirmation threshold yet leave `independentFamilyCount` at zero. The staged
policy then converts `TRADING_CONFIRMED` to `UNCERTAIN` and caps confidence at
79.

**Architectural limitation.** Evidence value and evidence lineage are optional
properties of a provider-specific aggregate. The final decision requires
lineage that the provider contract does not require or validate.

**Production impact.** This systematically harms channels recognized by native
execution/education phrases, especially where the global English vocabulary is
weak. It also makes “substantial evidence” visible in explanations without
allowing it to affect the lifecycle outcome.

**Long-term improvement.** Make document-level provenance mandatory for every
non-abstention assertion. Reject/quarantine malformed evidence at the provider
boundary. Emit observation records first, then derive provider summaries. Every
observation needs document ID, source family/entity, field, span, timestamp,
language/script, concept ID/version, and extractor version.

**Tradeoffs.** More records and migrations; historical evidence without lineage
must be replayed or treated as non-corroborating. This is preferable to guessing
independence.

### F2 — The video provider destroys the granularity needed by the safety gate (P0)

**Current behavior.** All recent video matches are collapsed into one item per
category. Terms are deduplicated across videos, and provenance fields are built
from all videos matching any term. The consistency item contains every title,
including non-matching ones. Descriptions are generally attributed as title
fields. The gate then tries to reconstruct independent documents from these
aggregate arrays.

**Architectural limitation.** Extraction, aggregation, and scoring occur inside
providers before entity resolution. The system cannot distinguish ten genuine
video assertions from one repeated phrase or determine which term supports
which document.

**Production impact.** Genuine recurring trading practice may not count as
independent corroboration when IDs/families are absent. In the opposite
direction, coarse field arrays can overstate independence. Both recall and the
precision guarantee are weakened.

**Long-term improvement.** Emit one atomic observation per
document/concept/span, resolve source entities, deduplicate exact and semantic
duplicates, then compute recurrence, diversity, and temporal persistence as
derived features. Do not use provider identity as a proxy for independence.

**Tradeoffs.** Higher storage and compute cost; bounded sampling and deterministic
feature materialization are required.

### F3 — Country-selected language coverage is not content-selected (P0)

**Current behavior.** Knowledge packs are chosen from the declared country. A
multilingual country gets its configured language list, but an unknown country
falls back to English. Code-switching, diaspora creators, non-primary languages,
transliteration, and languages absent from the static union rely on the optional
semantic provider. Static channel and video providers principally consume the
primary `languageKnowledge`, not all detected content languages.

**Architectural limitation.** Locale, language, script, country, and market are
coupled in hand-built country objects. There is no routing step that selects
language/concept surfaces per document from detected language and script.

**Production impact.** Equivalent trading evidence receives unequal coverage by
country and language. New countries scale through code changes and curated
lists, with silent English fallback masking unsupported coverage.

**Long-term improvement.** Use a global concept ontology with versioned surfaces
tagged by language, script, locale, market, validity, ambiguity, and provenance.
Detect language/script per field, retrieve all applicable surfaces, and use
country/market only as context—not as a vocabulary switch. Explicitly report
coverage and out-of-vocabulary state.

**Tradeoffs.** Homographs and transliteration increase ambiguity. Sense-level
approval, contextual disambiguation, and per-language calibration are necessary.

### F4 — Useful inputs are collected but not consumed consistently (P0)

**Current behavior.** The raw schema admits playlists, transcript excerpts,
visual evidence, pinned comments, activity, and rich external-link details.
Gemini sees bounded playlists/transcripts, but deterministic providers largely
operate on channel text, legacy video arrays, and URLs. The multilingual
“complete” text excludes playlists, transcripts, visuals, pinned comments, and
activity. Visual and activity inputs have no production evidence provider.

**Architectural limitation.** There is no canonical document projection shared
by all extractors. Each provider chooses a different subset and representation.

**Production impact.** Evidence already paid for at enrichment can be invisible
to confirmation. Recall depends on which field happens to carry a term, and a
semantic outage disproportionately affects rich non-English evidence.

**Long-term improvement.** Normalize every input into a typed, immutable
document corpus before extraction. Providers consume that corpus under explicit
capability manifests. Add deterministic playlist/transcript/link-label adapters;
visual evidence remains model-derived and must retain model provenance.

**Tradeoffs.** Transcripts and descriptions are noisy and can contain quoted or
third-party content. Apply source-specific reliability, quote/boilerplate
filtering, and temporal limits.

### F5 — “Confidence” is an uncalibrated net-weight display (P0)

**Current behavior.** Confidence is `clamp(round(50 + positiveWeight -
negativeWeight))`. It starts at 50 with no evidence, adds overlapping provider
emissions linearly, then is forcibly raised to at least 82 on heuristic
confirmation, capped at 79 after a stage veto, or capped at 22 on rejection.
Semantic confidence is separately mapped through five bootstrap bins.

**Architectural limitation.** Evidence strength, class probability, data
coverage, and workflow state share one number. Weight multiplication is
inconsistent across providers (for example consistency weight omits its
confidence factor), and correlated matches can be counted repeatedly.

**Production impact.** A 79 does not mean a 79% probability and often means only
“the gate vetoed a positive heuristic.” Threshold tuning cannot be interpreted,
compared across cohorts, or safely generalized.

**Long-term improvement.** Separate outputs:

* calibrated `P(trading-focused | evidence)`;
* calibrated `P(non-trading-focused | evidence)` or contradiction risk;
* epistemic/coverage uncertainty;
* evidence quality and independence;
* lifecycle action and reason.

Fit calibration on frozen, time-split, human-reviewed snapshots with hierarchical
partial pooling across language/market cohorts. Use lower confidence bounds for
automatic confirmation and measure expected calibration error, Brier score,
selective risk, precision, recall, and abstention coverage.

**Tradeoffs.** Calibration needs enough representative labels and drift
monitoring. Small cohorts must inherit global priors rather than receive bespoke
thresholds.

### F6 — Two decision systems disagree and the less expressive one wins (P0)

**Current behavior.** The score strategy has four disjunctive positive rules,
including single-methodology and raw-weight shortcuts. The staged system requires
a semantic-category candidate plus independent corroboration. A score-confirmed
result is overwritten unless the stage action is `CONFIRM`. Contradiction also
uses different rules in each layer.

**Architectural limitation.** Arithmetic policy and safety policy independently
encode the class boundary. There is no single typed decision contract or formal
mapping from evidence features to action.

**Production impact.** Strong score explanations conflict with the delivered
status; operators see “Needs Review” without a faithful marginal reason. Any
threshold change can be nullified by the other layer, making tuning brittle.

**Long-term improvement.** Build one decision policy over a versioned feature
snapshot. Safety constraints should be explicit predicates inside that policy:
minimum independent support, contradiction ceiling, coverage floor, and
calibrated probability bound. Produce one immutable decision trace with the
failed predicate and distance-to-boundary.

**Tradeoffs.** Consolidation changes replay semantics and needs dual-run
validation. Preserve the old path as a comparator, not a second authority.

### F7 — Candidate detection recognizes only a narrow category subset (P1)

**Current behavior.** The candidate gate accepts semantic model positives,
methodology, terminology, or instrument categories. Explicit platform/broker,
external-resource, and multi-video evidence does not itself create a candidate.
At the same time, the score policy contains a platform shortcut.

**Architectural limitation.** “Candidate” is inferred from output categories
rather than a governed trading-focus hypothesis. Category eligibility is
duplicated and inconsistent.

**Production impact.** A channel with repeated, independently attributable
platform/execution evidence can score strongly but fail candidate detection.

**Long-term improvement.** Define a concept-to-hypothesis mapping. Strong
platform evidence should support trading only when combined with creator-practice
or recurring market-analysis evidence; a mere affiliate link should not. Encode
these conjunctions as learned/calibrated features plus explicit safety rules.

**Tradeoffs.** Platform references are common in sponsorship and scam content;
they cannot confirm alone.

### F8 — Negative evidence is lexically broad and conflict handling is coarse (P1)

**Current behavior.** Static providers match negative terms over concatenated
channel/video text without local context. Adjacent-finance evidence is suppressed
when any execution/education phrase exists, while any hype item blocks every
positive confirmation shortcut. Dominant contradiction is based on aggregate
weight (`>=25` or `>1.5x` positive), not scope, recency, prevalence, or entailment.

**Architectural limitation.** Polarity is binary and assertion scope is absent.
A quotation, warning, old upload, isolated hype title, or dominant channel theme
are represented similarly.

**Production impact.** A genuine trading educator discussing scams or using one
hype-like phrase can be routed to review. Conversely, one trading phrase can
suppress adjacent-finance context too readily.

**Long-term improvement.** Represent negative assertions atomically with scope,
target, stance, prevalence, recency, and document attribution. Resolve conflicts
per concept/document and then at creator-focus level. Require persistent or
high-prevalence contradiction for a veto, while retaining hard safety flags for
deception and prohibited behavior as a separate axis.

**Tradeoffs.** Stance detection is model-sensitive. Ambiguous negatives must
abstain and cannot be silently discounted.

### F9 — Sufficiency measures presence, not coverage quality (P1)

**Current behavior.** Two video titles, a 40-character description, one external
link, playlist, or transcript can make context substantive. Any evidence item,
including a zero-weight semantic abstention, can make collection sufficient.
Provider unavailability does not degrade collection; runtime failure does, though
degradation no longer vetoes otherwise sufficient evidence.

**Architectural limitation.** A single `MISSING/INSUFFICIENT/SUFFICIENT` state
collapses document count, freshness, language support, provider applicability,
and missing corroboration dimensions.

**Production impact.** Sparse/noisy snapshots enter terminal scoring while rich
unsupported-language snapshots appear equivalent to well-covered ones. The
enrichment controller receives imprecise gaps.

**Long-term improvement.** Introduce a coverage vector: identity, recent content,
document diversity, temporal span, language support, link resolution,
transcript/visual availability, and provider health. Decision policy consumes
the vector; value-of-information routing selects only the missing dimension.

**Tradeoffs.** More lifecycle states are operationally complex. Keep the external
status small but expose detailed machine-readable reason codes.

### F10 — The semantic provider is useful but structurally unable to carry recall (P1)

**Current behavior.** It is optional, truncates to 12 videos, six playlists and
four transcripts, and truncates each document to 1,200 characters. A single
channel-level taxonomy label becomes one medium-reliability item. The adjudicator
runs only when enabled and only for supported low-confidence/ambiguous results.
Bootstrap calibration caps even the highest raw confidence at 84.

**Architectural limitation.** One model call performs language detection,
document interpretation, creator-focus aggregation, and taxonomy classification.
It cannot express mixed focus or multiple independent assertions.

**Production impact.** Semantic understanding cannot reliably rescue vocabulary
gaps, and an outage exposes static-language inequities. Multiple citations do not
automatically become independently weighted observations.

**Long-term improvement.** Use semantic models as bounded assertion extractors
over individual documents, followed by deterministic aggregation and calibrated
creator-focus classification. Cascade only unresolved cases to a stronger model.
Require citation validation and run semantic-off parity evaluation.

**Tradeoffs.** More calls, latency, and cost. Cache immutable document assertions,
batch work, and enforce budgets/deadlines.

### F11 — Governed terminology and evidence graphs arrive too late (P0)

**Current behavior.** The adaptive classifier normally runs in shadow. Production
integration is flag-gated, requires existing production-positive evidence and no
negative evidence, and retains additional multi-concept corroboration rules. The
adaptive implementation re-runs the scoring strategy without passing the
original collection/staged report, so default stages can abstain. Evidence-graph
matches add small corroboration-only weights.

**Architectural limitation.** Learning is an adjunct classifier after the static
decision rather than a versioned knowledge projection consumed during atomic
extraction and feature construction.

**Production impact.** Reviewed concepts cannot help the zero-static-match cases
that need them most. Knowledge may raise a shadow score without satisfying
production provenance gates.

**Long-term improvement.** Publish approved concepts/surfaces into an immutable,
signed classification-lane artifact loaded before provider execution. Governed
knowledge may propose observations, never statuses. It must pass the same
provenance, ambiguity, independence, contradiction, and calibration controls as
curated knowledge.

**Tradeoffs.** A bad publication has wider blast radius. Require moderation,
minimum cohort support, checksum pinning, canary/shadow replay, rollback, expiry,
and kill switches.

### F12 — Evaluation optimizes discovery candidates, not classifier selective risk (P0)

**Current behavior.** The offline evaluator measures result relevance, verified
quality, incremental coverage, quota, and review cost for candidate catalogs.
The regression suite contains fixtures, but the production decision diagnostics
are not shown feeding a stratified, time-split classification calibration and
promotion gate. Corrective learning records incidents only after review/delayed
confirmation and proposes changes without automatic publication.

**Architectural limitation.** Discovery-term evaluation, classifier evaluation,
calibration, and post-decision learning are separate control planes without one
end-to-end metric contract.

**Production impact.** The team cannot quantify where genuine channels abstain,
compare recall at a fixed precision, identify language/market coverage gaps, or
prove a change preserves safety. Aggregate accuracy could hide severe cohort
regressions.

**Long-term improvement.** Build immutable classification snapshots joined to
authoritative labels and decision traces. Report precision-recall and abstention
coverage globally and by predeclared language, script, country, market, evidence
availability, acquisition source, and channel-size cohorts. Promotion requires:

* no statistically credible reduction below the production precision floor;
* improved recall or reduced abstention at that floor;
* bounded worst-cohort regression with minimum sample rules;
* stable calibration and provider-failure behavior;
* adversarial, ambiguity, leakage, and duplicate-source tests.

**Tradeoffs.** Labels are delayed and selection-biased. Use blinded stratified
review, disagreement adjudication, inverse-propensity analysis where defensible,
and always publish confidence intervals/sample counts.

### F13 — Recency, prevalence, and creator focus are not first-class (P1)

**Current behavior.** Published dates can appear in provenance but do not affect
weight. Matches are deduplicated into term lists, while consistency is a simple
fraction over supplied titles. Sampling completeness and content-type mix are
not modeled.

**Architectural limitation.** The classifier recognizes terms, not a temporal
creator-focus distribution.

**Production impact.** A genuine channel with varied vocabulary can look weaker
than a keyword-dense channel; an old trading phase can look as current as recent
practice. Shorts, live streams, and long-form analysis are treated alike.

**Long-term improvement.** Derive time-decayed prevalence, persistence,
document-type diversity, and effective sample size from atomic observations.
Calibrate these features rather than hard-coding one consistency ratio.

**Tradeoffs.** Decay can hurt low-frequency experts. Missing publication dates
must widen uncertainty rather than count negatively.

### F14 — Configuration and versioning do not fully describe decisions (P1)

**Current behavior.** Global mutable scoring configuration can change in-process.
Provider weights are also hard-coded outside that configuration. Engine versions
do not pin every term list, prompt setting, feature projection, threshold, or
runtime flag. Evidence IDs include time and randomness.

**Architectural limitation.** A decision lacks one immutable policy artifact and
deterministic feature checksum.

**Production impact.** Exact replay and causal comparison are difficult; rollout
results can mix policies, and nondeterministic IDs complicate evidence diffs.

**Long-term improvement.** Pin a complete decision manifest: corpus checksum,
ontology publication, extractor versions, feature schema, calibration artifact,
policy predicates, thresholds, model/prompt, runtime capabilities, and rollout
cohort. Generate content-addressed observation IDs.

**Tradeoffs.** More artifact management; it materially improves auditability and
rollback safety.

### F15 — Corrective-learning diagnosis reads a different shape than diagnostics store (P0)

**Current behavior.** Production diagnostics store the stage report in the
top-level `staged_report` column and store only a compact status/score/weight
summary in `decision`. Corrective learning instead reads
`decision.stagedClassification` and `decision.evidenceCollection`. Consequently,
retrieved incidents can appear to have no candidate, no corroboration, and
insufficient evidence regardless of the recorded stage/provider data. The
diagnoser also compares against a hard-coded threshold of 70 while the active
score configuration uses 65 and contains additional shortcut rules.

**Architectural limitation.** Persisted decision traces have no shared,
version-validated schema, and downstream consumers use untyped JSON paths and
reconstruct policy semantics.

**Production impact.** False-negative proposals can receive the wrong causal
class. This does not directly change today's classification, because publication
is governed, but it corrupts the feedback signal intended to improve future
recall and can conceal the true gate causing abstention.

**Long-term improvement.** Define one typed/versioned diagnostic envelope and
validate it on write and read. Corrective learning must consume the persisted
stage column/provider report or, preferably, the same immutable feature and
decision manifest used by production. Never re-encode active thresholds in the
learner; reference the pinned policy artifact. Backfill/replay affected incidents
before using them for evaluation or proposals.

**Tradeoffs.** Schema migration and incident replay are required. Invalid legacy
rows should be explicitly marked, not silently interpreted.

## 4. Recommended target architecture

### 4.1 Canonical evidence plane

1. **Snapshot:** Persist an immutable channel snapshot and typed documents.
2. **Normalize:** Unicode/script-aware normalization without discarding the raw
   text; resolve channel, video, playlist, link, and quoted-source identities.
3. **Route:** Detect language/script per document and retrieve governed concept
   surfaces independent of country.
4. **Extract:** Deterministic and semantic extractors emit atomic assertions.
5. **Validate:** Enforce schema, citations, content bounds, and policy versions.
6. **Resolve:** Deduplicate correlated assertions by concept, document, entity,
   source family, and derivation lineage.
7. **Materialize:** Build an immutable feature vector containing strength,
   diversity, prevalence, recency, coverage, contradiction, and uncertainty.

### 4.2 One selective decision policy

Use a calibrated monotonic model or interpretable generalized additive model over
the materialized features, constrained so better independent positive evidence
cannot reduce trading support and missing evidence cannot become negative. A
single policy chooses:

* `CONFIRM` when the lower bound of trading probability exceeds the precision
  operating point, minimum independent support is met, coverage is adequate, and
  no dominant contradiction/safety constraint fails;
* `REJECT` only with calibrated affirmative non-trading evidence and required
  coverage;
* `ENRICH` when a specific obtainable evidence gap could change the action; or
* `REVIEW` when evidence is intrinsically conflicting, unsupported, high-risk,
  or enrichment value is exhausted.

“Needs Review” should remain a workflow presentation of `REVIEW`, not an
independent classifier label. Probability, evidence quality, and workflow action
must remain separate fields.

### 4.3 Precision-preserving evidence combinations

The model should learn from atomic evidence, while hard policy requires safe
combinations such as:

* recurring creator-authored execution/methodology assertions across independent
  recent documents;
* methodology plus a specific instrument/market across separate documents;
* creator practice plus a governed platform/workflow concept;
* high-quality semantic assertions corroborated by deterministic concepts or a
  second independent document.

It should explicitly *not* confirm from a channel name, one generic finance term,
one affiliate link, provider agreement over the same text, country identity,
popularity, or governed knowledge alone.

### 4.4 Global knowledge model

Replace parallel global/language/country arrays with a concept registry:

```text
Concept
  identity + class + definition + risk/ambiguity
  -> Surface(language, script, locale, transliteration, sense, validity)
  -> Market applicability(country/region/exchange/instrument; contextual only)
  -> Provenance and moderation
  -> Lane policy(discovery, classification, query expansion)
  -> Publication/version/checksum
```

This makes adding a country primarily a coverage and calibration operation, not
a fork of decision logic. The same concept identity is shared across languages;
surfaces and calibration cohorts may differ.

### 4.5 Safety and learning controls

* Preserve abstention for insufficient/unsupported evidence.
* Separate trading relevance from fraud, hype, suitability, country eligibility,
  and community-link safety.
* Never treat provider failure, missing terminology, or unsupported language as
  negative creator evidence.
* Require human approval and offline evaluation before knowledge publication.
* Shadow, canary, compare, and auto-rollback on precision/calibration/provider
  guardrails.
* Prevent self-training: model decisions and unreviewed discoveries are not
  ground truth; derived duplicates share lineage and effective sample weight.
* Monitor label delay, reviewer disagreement, drift, coverage, and selective
  risk. Retain kill switches and immutable audit traces.

## 5. Prioritized implementation plan

### P0 — Establish truth and remove structural loss (before threshold changes)

1. **Decision-trace audit dataset.** Join immutable snapshots, atomic inputs,
   provider outcomes, evidence, stage metrics, final actions, later labels, and
   review provenance. Stratify and blind a representative review sample.
2. **Loss funnel dashboard.** Count authoritative positives at collection,
   candidate, score, corroboration, contradiction, and lifecycle steps. Report
   “would confirm but for gate,” missing provenance, unsupported language,
   provider failure, and evidence-gap cohorts.
3. **Mandatory provenance contract.** Add validation and shadow diagnostics first;
   update all providers to atomic document attribution. Do not relax
   corroboration while provenance is incomplete.
4. **Canonical document corpus.** Ensure all collected evidence types reach
   eligible extractors under a shared schema.
5. **Unified replayable policy manifest.** Make old and proposed decisions fully
   deterministic and comparable.
6. **Repair the diagnostic contract.** Version and validate the stored envelope,
   correct corrective-learning field access, and replay affected incident
   diagnoses before they inform proposals.

**Exit criteria:** representative sample and confidence intervals exist; every
non-abstention evidence item has valid lineage; the loss funnel accounts for at
least 99% of terminal and abstained decisions; exact replay is stable.

### P1 — Build the new classifier in shadow

7. Publish the global concept/surface ontology into an immutable classification
   artifact and route by detected document language/script.
8. Materialize deduplicated source-independent, temporal, prevalence, coverage,
   and contradiction features.
9. Train/calibrate the selective classifier on time-split labels; retain explicit
   precision and safety constraints.
10. Replace coarse negative vetoes with scoped contradiction features and keep a
   separate hard-safety axis.
11. Emit one decision trace with counterfactual gap and distance to each policy
    boundary.

**Exit criteria:** on untouched temporal holdout, recall/automation coverage
improves at the existing precision floor; no supported cohort breaches its
predeclared regression bound; calibration and provider-failure tests pass.

### P2 — Controlled production adoption

12. Run shadow parity, then a small deterministic canary across stratified
    countries/languages/markets—not handpicked channels.
13. Automatically promote only cohorts meeting minimum sample and lower-bound
    guardrails; otherwise inherit the global safe policy or remain shadow.
14. Route `ENRICH` with value-of-information actions and stop repeated low-value
    acquisition.
15. Gradually retire the dual score/stage authority after replay equivalence,
    incident drills, rollback validation, and operator sign-off.

**Exit criteria:** sustained precision, improved genuine-channel recall, bounded
review load/cost/latency, no safety regression, and successful rollback exercise.

### P3 — Continuous governed evolution

16. Feed adjudicated false negatives and false positives into diagnosis, not
    directly into training or terminology publication.
17. Schedule drift/calibration checks and terminology expiry/revalidation.
18. Expand languages and markets through ontology coverage, cohort evaluation,
    and publication workflow; never through per-country decision exceptions.

## 6. Required evaluation matrix

Every release report should include:

| Dimension | Required measures |
|---|---|
| Global | precision, recall, PR curve, abstention/automation coverage, review rate |
| Calibration | Brier score, ECE, reliability plot, lower-bound precision |
| Cohorts | language, script, country, market, code-switching, unknown-country, provider availability |
| Evidence | document count/type, source-family count, transcript/link/playlist availability, sparse/rich |
| Temporal | time-split holdout, label delay, drift, old-vs-recent content |
| Safety | irrelevant-domain, adjacent finance, hype/scam, quotation/negation, affiliate-only, adversarial repetition |
| Operations | latency, cost, timeout rate, enrichment yield, review queue, rollback correctness |

Report sample sizes and confidence intervals. Do not publish a cohort metric
below its minimum sample; pool it hierarchically and disclose that choice.

## 7. Changes explicitly rejected

* Lowering `minPositiveWeightTrading`, the score threshold, or corroboration
  requirement globally.
* Confirming from a trading-looking name, country term, broker link, or model
  assertion alone.
* Adding special cases for reported channels, countries, or languages.
* Counting two providers reading the same document as two independent sources.
* Treating an outage, unsupported language, or missing term as non-trading.
* Letting learned terms publish automatically or allowing production predictions
  to become their own labels.
* Optimizing aggregate recall without a fixed precision floor and cohort safety
  bounds.

## 8. Final recommendation

Begin with P0 instrumentation and provenance, not scoring changes. It will expose
how much of the current review population is caused by missing lineage,
language-routing gaps, unsupported evidence fields, genuine conflict, or lack of
data. Then introduce the provenance-first concept model and calibrated selective
policy in shadow. This path allows independent, multilingual evidence already
present in the corpus to combine correctly while keeping confirmation dependent
on measurable precision, source independence, and explicit safety constraints.
