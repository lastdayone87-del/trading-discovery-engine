# Hybrid pipeline design (PROPOSAL ONLY — not implemented, not approved)

Local classifier → uncertain/borderline cases → LLM adjudication.

## Architecture

```
RawChannelInput
  → deterministic features/text assembly (unchanged engine code)
  → local classifier (label, p_trading)
  → router (fitted thresholds t_low < t_high, re-fit as gold grows):
      p >= t_high        → TRADING (no LLM call)
      p <= t_low         → NOT_TRADING (no LLM call)
      t_low < p < t_high → ABSTAIN → current Gemini/Groq path (unchanged)
```

Abstention is a first-class outcome, not an error: the abstain band carries
the cases where local evidence is insufficient, preserving today's
SEMANTIC_MODEL_ABSTAINED semantics downstream (weight→0, human review where
configured).

## Threshold policy (data-driven, never assumed)

- Fit (t_low, t_high) on pooled out-of-fold probabilities against gold labels
  for explicit targets, e.g. P>=0.99 on decided mass with maximal coverage.
- Re-fit on every gold-label batch (the labels/*.txt mechanism); thresholds
  are versioned artifacts (thresholds.vN.json: {t_low, t_high, fitted_at,
  gold_n, precision_at_fit}), never hard-coded constants.
- Monitor live: abstention rate, decided precision proxy (human spot-check
  queue sampled from decided mass), calibration drift (binned predicted vs
  spot-check outcomes). Alert on drift; fall back to wider bands, never to
  silent auto-decide.

## What production would eventually require (NOT done — inventory only)

1. `server/evidenceEngine/` — new `LocalClassifierProvider implements
   EvidenceProvider` (label + calibrated confidence only; no concepts,
   citations, or explanations — downstream consumers of those fields keep the
   LLM path or a retrieval fallback).
2. Router + thresholds artifact loading (env-gated, default OFF; kill-switch
   reverts to pure-LLM path with zero code deploy).
3. `SEMANTIC_*` taxonomy mapping: classifier-positive → existing positive
   categories with capped confidence; classifier-negative → negative;
   abstain → current abstention path unchanged.
4. Provider routing: abstain-band calls keep current Gemini/Groq routing,
   quotas, and cooldowns untouched.
5. NO changes to: crawler budgets/caps, retry policy, scoring weights of
   other evidence, relationship discovery, queue/worker topology, DB schema
   (thresholds live as a versioned file/asset, not schema).

## Validation plan (before any traffic)

1. Offline replay: run hybrid policy over historical enrichments; compare
   decisions, abstention rate, and LLM-call reduction vs full-LLM baseline.
2. Shadow measurement (see SHADOW_MODE_DESIGN.md).
3. Forced-traffic canary on a fixed channel cohort with human spot-checks.
4. Rollback drill: kill-switch returns to pure-LLM within one deploy.
