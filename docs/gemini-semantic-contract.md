# Gemini Provider Contract — Semantic Classification & Vocabulary (Stage 1 specification)

> Status: SPECIFICATION ONLY (Stage 1 of the production Gemini-fallback finding).
> No fallback implemented: exact output parity with an alternate provider is
> unverifiable in this environment (no provider credentials, no live eval
> harness, no labeled ground truth). Do not implement a fallback until the
> parity requirements in §7 are met. No scoring, evidence, or calibration
> changes were made for this document.

## 1. Call sites (all three must be ported for any fallback)

| # | Call site | Operation | Timeout | Retries | Degraded behavior |
|---|-----------|-----------|---------|---------|-------------------|
| 1 | `GeminiSemanticProvider.collectEvidence` (`server/evidenceEngine/providers/GeminiSemanticProvider.ts:166`) | `multilingual-semantic-classification` via `executeProviderCall` + route failover | `GEMINI_PROVIDER_TIMEOUT_MS` default 135000 | Route failover except on 429 (project-level); 404 model fallback to adjudicator model once | No client → `[]`; provider error propagates (provider-level retry/backoff owns recovery) |
| 2 | Vocabulary extraction `extractVocabularyFromCreator` (`server/queryIntelligence.ts:192-283`) | `vocabulary-extraction`, 45s timeout, 2 retries @1500ms | 45000 | `callGeminiSafe` retries=2 | 429/503 → warn + **heuristic extraction retained** (graceful, no throw) |
| 3 | Assertion labeling (`server/candidateScoring.ts:69`) | per-span classify, exact JSON keys `literalSpan,label,confidence,abstained,reasonCodes`, closed `ASSERTION_LABELS` | — | throws when `GEMINI_API_KEY` missing | throw (fail-closed) |

## 2. Structured output contract (call site 1)

Request: JSON `{task: CANDIDATE|ADJUDICATION, promptVersion: 'priority2-multilingual-structured-1', closedTaxonomy (7 labels), instructions[5], declaredCountry, declaredLanguageHints, documents[{ref,text}]}` with `responseMimeType: application/json`, `temperature: 0`. Documents: ≤40 corpus docs (or title+bio+≤12 videos+≤6 playlists+≤4 transcripts), each text sliced to 1200 chars; country/language/activity surfaces excluded.

`SemanticModelResult` fields/types (`GeminiSemanticProvider.ts:15-23`, normalized by `parse()`, `:131-141`):
- `label`: one of `ACTIVE_TRADING, INVESTING_EDUCATION, FINANCIAL_NEWS, PERSONAL_FINANCE, HYPE, UNRELATED, AMBIGUOUS`, else forced `AMBIGUOUS`
- `confidence`: number clamped 0..100
- `supportedLanguage`: strict `=== true`
- `reasonCodes`: string[], max 8
- `explanation`: string (default `'Semantic model abstained.'`)
- `concepts`: string[], max 12
- `languages`: `{language, script, confidence 0..100, field}` filtered to known `EvidenceFieldRef` fields
- `citations`: `{field, index?, sourceId?}` filtered to known fields

## 3. Evidence categories + scoring mapping

Derived per collection (`:179-192`): `calibrated = calibrateSemanticConfidence(confidence)` via bootstrap bins 49→35, 64→50, 79→64, 89→75, 100→84 (`semanticCalibration.ts`, top tier 84 — policy confidence, not production probability). Abstain iff `!supportedLanguage || label===AMBIGUOUS || calibrated<50 || citations.length===0`. Categories: abstain→`SEMANTIC_ABSTENTION`; `ACTIVE_TRADING|INVESTING_EDUCATION`→`METHODOLOGY_CONCEPT`; `HYPE`→`HYPE_SPECULATION`; `UNRELATED`→`IRRELEVANT_DOMAIN`; else `NON_TRADING_ADJACENT`. Weights: abstain 0; positive raw 24 else 26; final `rawWeight × .65 × (calibrated/100) × (±1 polarity)`. Reliability MEDIUM×.65 (LOWER×.4 when abstained). Provenance: `structured-semantic:{model}` + semantic block (model/prompt/feature/calibration versions, taxonomy label, raw+calibrated confidence, languages, reasonCodes). Second-tier adjudication runs only when supported + (AMBIGUOUS or confidence<70) + `MULTILINGUAL_ADJUDICATION_ENABLED==='true'` + model differs.

## 4. Degraded/missing behavior (must-match for any fallback)

- No keys: provider `UNAVAILABLE`, evidence `[]` (never throws, never fabricates).
- 429: NO cross-key failover (project-level limits); shared cooldown `GEMINI_SEMANTIC_RATE_LIMIT_COOLDOWN_MS` default 90000 gates all routes (`providerResilience.ts:121-141`).
- 404 model: single retry with adjudicator model + `SEMANTIC_CANDIDATE_MODEL_404_FALLBACK` reason code.
- Caller level: ENRICH deferral storm already gated (`queueManager.ts` Gemini-cooldown gate); provider-failure evidence handling lives in `evidenceEngine/index.ts` + `enrichmentOperationalFailure.ts`, untouched.

## 5. Rate-limit / cost envelope (current, observed from code)

Per classification: 1–2 model calls (candidate + conditional adjudication), 135s timeout each, temperature 0, JSON mode, ≤40 documents × ≤1200 chars. Cooldown 90s shared across routes on any 429. Key pool: `GEMINI_API_KEY`, `GEMINI_API_KEY_2..N` deduped, ordered (`configuredGeminiRoutes`). No per-call cost accounting in-repo; quota pressure is expressed as cooldowns + deferrals, not token metering.

## 6. Fallback candidate evaluation (static, no live calls made)

| Candidate | Interface fit | Exact-parity verdict |
|-----------|---------------|----------------------|
| Claude Haiku 4.5 (Anthropic Messages API + JSON mode) | Feasible via a `SemanticModelClient` adapter (new dep) | **Unproven**: taxonomy adherence, citation discipline, abstention calibration, and multilingual quality are model behaviors the `parse()` fallbacks cannot normalize; different distributions change EvidenceItems and scores |
| GPT-4o Mini (OpenAI chat completions JSON mode) | Same as above | **Unproven**, same reason |
| Groq Llama 3 (OpenAPI-compatible) | Same as above | **Unproven**, same reason |

Blocking gaps for ANY fallback (all three call sites, not just classification): no provider credentials in this environment; no side-by-side eval harness; no labeled multilingual ground truth; calibration artifact (`multilingual-semantic-calibration-bootstrap-1`) is fit to Gemini's output distribution and would need re-fitting; per-provider rate-limit/cooldown semantics differ from `providerResilience`'s Gemini-shaped model; two new SDK dependencies + key rotation/pooling to build.

## 7. Requirements before any fallback implementation

1. Provider credentials + side-by-side harness replaying fixed prompt corpus through Gemini and the candidate.
2. Parity gates: taxonomy confusion matrix within tolerance, citation-field validity, abstention-rate bounds, calibrated-confidence distribution match, downstream decision agreement on a labeled set.
3. Re-fit or explicitly re-adopt the calibration artifact for the new model.
4. Port all three call sites (classification, vocab extraction incl. heuristic fallback, assertion labeling) — not just site 1.
5. Staged rollout behind the existing provider-deadline/cooldown machinery with instant revert.

## 8. Backlog posture (unchanged)

No bulk requeue/reset/processing of the 1,460+ pending candidates. Existing deferral, cooldown, and per-candidate retry directives continue to drain the backlog naturally. This document changes zero runtime behavior.
