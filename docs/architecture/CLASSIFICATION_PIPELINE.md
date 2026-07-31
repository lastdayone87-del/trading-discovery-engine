# Classification Pipeline

**Status:** Production specification for evidence engine v2.1
**Related:** [Architecture Overview](./ARCHITECTURE_OVERVIEW.md) · [Learning Pipeline](./LEARNING_PIPELINE.md) · [Roadmap](./ROADMAP.md)

## Purpose

The classification pipeline determines whether a discovered creator is demonstrably focused on trading, demonstrably focused elsewhere, or requires more evidence. It is designed as an evidence and lifecycle system, not a keyword yes/no filter.

## Production flow

```text
Discovered channel observation
        │
        ▼
Country validation and exclusion gate
        │ accepted
        ▼
RawChannelInput
  - channel name
  - description
  - recent video titles
  - recent video descriptions
  - resolved country / location
  - external links
  - optional Discord invite
        │
        ▼
Parallel evidence providers + availability reports
        │
        ▼
Evidence collection report
  - provider states
  - fields present
  - sparse metadata
  - degradation
  - sufficiency
  - reason codes
        │
        ▼
Staged field-aware policy
  - availability and sufficiency
  - semantic candidate detection
  - independent corroboration
  - dominant contradiction analysis
  - lifecycle routing
        ├── TRADING_CONFIRMED ─► community inspection and quality analysis
        ├── NON_TRADING ───────► terminal skip with diagnostics
        └── UNCERTAIN ─────────► durable enrichment, then review if unresolved
```

The country gate is intentionally separate: country confidence and trading relevance answer different questions and must not be collapsed into one score.

## Provider model

Production runs these providers concurrently:

| Provider | Main inputs | Positive evidence | Negative evidence | Important limitation |
|---|---|---|---|---|
| Channel metadata | Name, description | Instruments, platforms, methodologies, terminology | Irrelevant-domain terms | Field content is lexicon-driven and title prominence is not modeled independently |
| Video metadata | Recent titles and descriptions | Repeated focus, instruments, platforms, methods | None solely from low match coverage | Vocabulary coverage is not semantic topic coverage |
| External links | Official channel links | Recognized trading platforms and prop-firm resources | None | Fixed domains; linked content is not fetched semantically |
| Country knowledge | Name, bio, titles, country pack | Exchanges, local instruments, native terms | Regional irrelevant domains | Static country/language packs |
| Multilingual context | Complete available text | Execution and education phrases | Adjacent finance, hype, motivation when practice is absent | Phrase packs cover only known languages and expressions |
| Multilingual semantic (Gemini) | Field-preserved channel, video, playlist, transcript, and language hints | Active trading and investing-education meaning | News, personal finance, hype, and unrelated meaning | Optional cost-tiered dependency; structured evidence only; cannot make a terminal decision alone |
| Discord | Invite, when already known | Community resource | None | Usually not applicable before downstream inspection |

Providers create evidence items with polarity, category, confidence, reliability, final weight, and provenance. Provider failure boundaries prevent one provider from aborting the full classification.

### Multilingual semantic boundary (v2.1)

Language/script observations are conceptually governed by the shared Priority 8
capability model: declared country is not a language assertion, fields may be
multiscript or transliterated, and unsupported or contradictory metadata must
abstain. The semantic provider already emits field observations; adopting the
compact `global-language-capability-v1` decision throughout extraction and
classification will pin the same normalization, reason codes, and provenance
used by discovery.

The compact multilingual model is the primary generalization provider for
meaning not represented in static packs. It receives separately identified
fields rather than flattened text and must return a closed taxonomy:
`ACTIVE_TRADING`, `INVESTING_EDUCATION`, `FINANCIAL_NEWS`,
`PERSONAL_FINANCE`, `HYPE`, `UNRELATED`, or `AMBIGUOUS`. Its assertion includes
field citations, detected language and script per field, concepts, reason codes,
and pinned model, prompt, feature, and calibration versions. Unsupported language,
missing citations, ambiguity, and confidence below policy threshold produce a
zero-weight `SEMANTIC_ABSTENTION`; they never fall back to English certainty.

Ambiguous cases may use a separately versioned adjudicator when enabled. The
semantic assertion remains medium-reliability evidence: positive assertions need
independent deterministic, entity, dimension, or repeated-video corroboration,
and one semantic negative assertion cannot cross the dominant-contradiction
threshold. This preserves the v2 staged architecture and makes explanations
inspectable while allowing unseen terminology, transliterations, loanwords, and
code-switching to enter candidate detection.

The `multilingual-semantic-calibration-bootstrap-1` artifact maps raw model
confidence into conservative policy bands. These scores are explicitly not yet
probabilities; production probability calibration awaits fitting and validation
on time-split human-reviewed multilingual outcomes.

## Provider availability semantics

Priority 0 made provider execution state explicit:

| State | Meaning | Scoring interpretation |
|---|---|---|
| `AVAILABLE` | Applicable provider ran | Its evidence may contribute; zero items means no item was found |
| `NOT_APPLICABLE` | Required input was absent | No semantic inference is allowed |
| `UNAVAILABLE` | Capability or configuration was absent | Mark collection degraded; do not create negative evidence |
| `FAILED` | Applicable execution failed | Mark collection degraded and retain the reason; do not create negative evidence |

Examples:

- no video titles makes the video provider `NOT_APPLICABLE`;
- no external links makes the link provider `NOT_APPLICABLE`;
- no Gemini API key makes Gemini `UNAVAILABLE`;
- a Gemini timeout or malformed response is a provider failure, not a vote for `NON_TRADING`.

This design exists because provider reliability and semantic polarity are orthogonal. A service outage describes the classifier, not the creator.

## Evidence sufficiency

The engine creates one `EvidenceCollectionReport` before scoring.

### `MISSING`

No classifiable metadata fields are present. The only valid production result is `UNCERTAIN`.

### `INSUFFICIENT`

Some metadata exists, but the available material and collected evidence cannot support a terminal conclusion. A sparse channel name without corroborating bio, videos, or links is a common case.

### `SUFFICIENT`

Substantive context or explicit evidence is available. Sufficient evidence does not imply a terminal label; conflicting or below-threshold evidence can remain `UNCERTAIN`.

The report also records:

- `sparseMetadata`;
- whether provider coverage is degraded;
- fields actually present;
- per-provider status and evidence count;
- machine-readable reason codes.

## Scoring and decision policy

The weighted strategy retains a neutral arithmetic baseline for compatibility
and explainability:

```text
positiveWeight = sum of absolute final weights for positive items
negativeWeight = sum of absolute final weights for negative items
netWeight      = positiveWeight - negativeWeight
confidence     = clamp(round(50 + netWeight), 0, 100)
```

This confidence is a policy score, not yet a calibrated probability. It cannot
directly select a workflow state. Terminal results are moved into reporting bands
only after the applicable stages pass.

## Staged decision policy (v2.0)

Every production decision includes a `stagedClassification` report with a
pipeline version, five ordered stage results, evidence identifiers,
machine-readable field references, metrics, and reason codes. Every semantic
stage supports `ABSTAIN`.

1. **Availability** passes only with sufficient, non-degraded evidence. Missing
   or insufficient cases route to enrichment; degraded cases route to review.
2. **Candidate detection** requires affirmative semantic, methodology,
   terminology, or instrument evidence. No recognized candidate is an
   abstention, never a negative assertion.
3. **Corroboration** requires a strong signal plus repetition across videos,
   independent providers, or independent evidence dimensions. Repetition inside
   one incidental field is insufficient.
4. **Contradiction** fails only for affirmative negative evidence that is
   dominant by configured policy weight. A non-dominant conflict remains
   diagnosable without becoming a rejection.
5. **Lifecycle** emits `CONFIRM`, `REJECT`, `ENRICH`, or `REVIEW`. A legacy
   positive score is downgraded to `UNCERTAIN` unless the lifecycle action is
   `CONFIRM`; a legacy negative score is likewise downgraded unless the action is
   `REJECT`.

The field-aware input supports structured videos, playlists, resolved external
links, independently detected languages, transcript excerpts, and visual
evidence with model provenance. Legacy title, description, and URL arrays remain
supported and are normalized at the engine boundary during migration.

### `TRADING_CONFIRMED`

A channel is confirmed through one of several positive routes:

- configured positive weight, score, and multi-video consistency;
- strong methodology or terminology evidence without negative veto categories;
- platform, prop-firm, or external-resource corroboration;
- sufficiently strong total positive weight without conflicting domain evidence.

Priority 0 did **not** lower these positive thresholds. This preserves the existing high-precision acceptance boundary.

### `NON_TRADING`

A channel requires affirmative negative evidence, such as:

- irrelevant-domain evidence with negligible positive trading evidence;
- substantial explicit negative weight;
- low confidence combined with an explicit irrelevant domain;
- adjacent-finance or hype evidence without enough trading methodology evidence.

Multi-video vocabulary non-coverage is excluded from explicit negative weight. Zero positive evidence, by itself, is not a negative condition.

### `UNCERTAIN`

The system abstains when:

- metadata is missing;
- metadata is sparse or insufficient;
- a provider outage degrades the available case;
- evidence is ambiguous;
- positive evidence is plausible but below confirmation thresholds;
- negative evidence is not strong enough for a terminal rejection.

`UNCERTAIN` is routed through durable enrichment and, if still unresolved, human review.

## Root cause of the false-negative incident

The reviewed French channel **Benjamin Deleuze - Trading** exposed a systemic error rather than merely a missing French term.

Before Priority 0:

1. French classification selected the French language pack.
2. The title contained a globally recognizable loanword but not one of the exact French pack phrases.
3. Sparse metadata and unavailable semantic evidence yielded zero positive evidence.
4. There was also zero negative evidence.
5. The baseline score remained 50.
6. The decision rule treated `positiveWeight === 0` and `confidence <= 50` as verified non-trading.
7. The terminal ingestion policy then skipped future automatic processing.

The critical invalid inference was:

```text
not recognized as trading  ⇒  verified as non-trading
```

That is closed-world reasoning and cannot scale to open-ended languages and markets.

## Priority 0 architectural correction

Priority 0 was implemented as one cohesive safety boundary:

1. Added explicit provider availability reports.
2. Added collection-level sufficiency and sparse-metadata semantics.
3. Made provider outages observable degradation rather than semantic evidence.
4. Removed the negative video penalty created solely by low static-term coverage.
5. Removed absence of positive evidence as a `NON_TRADING` condition.
6. Restricted heavy-negative logic to explicit negative evidence.
7. Routed missing and insufficient cases to `UNCERTAIN` for enrichment/review.
8. Added diagnostic logs and bumped evidence, decision, and scoring versions to 1.4.
9. Added replay tests for the reviewed false negative and boundary cases.

### Why `UNCERTAIN`, not automatic confirmation?

The title strongly suggests trading, but Priority 0 is a safety correction, not a replacement semantic classifier. Automatically confirming every sparse channel containing a plausible surface would exchange false negatives for false positives. The safe correction is to preserve the candidate until richer evidence or a future multilingual semantic stage can decide.

## Expected impact

- **Recoverable recall increases:** vocabulary misses no longer become terminal exclusions.
- **Trading-confirmed precision stays stable:** positive confirmation thresholds are unchanged.
- **Non-trading precision improves:** the label now requires affirmative negative evidence.
- **Enrichment and review volume increases:** previously hidden false negatives become visible abstentions.
- **Provider incidents become diagnosable:** availability and failure reasons appear in decision diagnostics.

No precise production percentage should be asserted until immutable outcomes are replayed against a representative human-reviewed multilingual corpus.

## Known limitations after Priority 0

- The production positive path still relies heavily on static vocabularies.
- Language context is often selected from country rather than detected per field.
- Semantic provider output is only one medium-reliability evidence item.
- Provider sufficiency heuristics are policy rules, not learned calibration.
- Video descriptions require stronger field-aligned handling.
- Playlists, transcripts, visual branding, and linked-site semantics remain underused.
- Confidence bands remain handcrafted rather than calibrated probabilities.

These limitations are addressed by Priorities 1 and 2 in the [Roadmap](./ROADMAP.md).

## Required regression coverage

Any classifier change must retain cases for:

- reviewed multilingual false negatives;
- completely missing metadata;
- sparse but suggestive metadata;
- rich but semantically unmatched metadata;
- provider unavailable and provider failed states;
- low vocabulary coverage across videos;
- explicit unrelated-domain channels;
- adjacent finance, news, hype, and motivation;
- authentic educators in each supported language;
- mixed positive and negative evidence;
- invariant behavior during provider outages.

## Priority 10 governed knowledge input

The classifier may consume an immutable classification-lane feature projection. Every feature retains concept and surface identity, concept version, publication version/checksum, and policy version. Governed features may add explainable candidate or corroboration evidence, but cannot bypass availability, sufficiency, independent corroboration, contradiction, or lifecycle stages. Missing or invalid knowledge abstains and uses the existing deterministic path; it is never negative evidence. Mutable graph, terminology, semantic, and discovery state are not classifier dependencies.
