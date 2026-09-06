# Local classifier POC — results (research only, do not merge into production)

## 1. Pipeline findings

Per-channel enrichment input (`RawChannelInput`): channel name, bio/description,
≤5 video titles + descriptions, social/channel links, playlists, transcript
excerpts, country/language hints. The LLM must return a closed-taxonomy label,
confidence 0–100, supportedLanguage, reasonCodes, explanation, concepts,
languages, citations (temperature 0, JSON mode, CANDIDATE tier; ADJUDICATION
tier dormant under default config since candidate/adjudicator models match).
Abstention (`SEMANTIC_MODEL_ABSTAINED`, weight→0) triggers on unsupported
language, AMBIGUOUS label, calibrated confidence <50, or zero citations.
Everything a local classifier needs is already collected as text — no new
data pipeline required.

## 2. Approaches verdict

- TF-IDF + Logistic Regression: viable baseline, tested below.
- TF-IDF + Linear SVM (Pegasos): best balance measured, tested below.
- Char-TFIDF + Logistic Regression: lowest false positives measured, tested below.
- Multilingual embeddings + LR: plausible (semantic generalization beyond
  keywords) but UNEVALUATED here — no torch/weights runtime in sandbox.
- SetFit / FastFit: designed for exactly this few-shot regime; UNEVALUATED
  (same environment reason). Specified as the next track, not skipped.
- TF-IDF+SVM/LogReg chosen over fancier options first because n≈50 gold
  cannot support anything with real capacity without overfitting theater.

## 3. Ground-truth audit (production, read-only)

| Tier | Source | Pos | Neg | Trust |
|---|---|---|---|---|
| Human gold | 37 user-confirmed ambiguous TRADING + 4 APPROVE + 3 REJECT decisions | 41 | 9 (3 unique REJECT channels; HUMAN_REJECTED coincides) | primary truth |
| Silver | trading_status NON_TRADING (47 channels, model-influenced) | 0 | 47 | train augmentation only, NEVER primary eval |
| LLM-generated | historical semantic labels | — | — | EXCLUDED from truth entirely |
| Unlabeled | rest of fleet | — | — | unused |

Insufficient-trustworthy-negatives flag: only 9 gold-negative channels exist;
all precision claims below rest on 3 unique gold negatives × CV repeats plus
the 47 silver channels reported separately. Near-duplicate audit (5-shingle
Jaccard): 0 pairs >0.3 — no leakage inflation. All evaluation is channel-held-out.

## 4. Benchmark results (repeated stratified 5-fold CV, pooled out-of-fold)

Experiment B — train gold+silver, evaluate GOLD ONLY (primary, n=132 pooled):

| model | P | R | F1 | FP | coverage@P=1.0 |
|---|---|---|---|---|---|
| tfidf-word+LR | 1.000 | 0.276 | 0.433 | 0 | ~0.85 @th 0.4 |
| tfidf-word+SVM | 1.000 | 0.683 | 0.812 | 0 | ~0.90 @th 0.35–0.4 |
| tfidf-char+LR | 1.000 | 0.081 | 0.150 | 0 | ~0.85 @th 0.4 |

Experiment C — all-91 CV with silver labels (secondary, model-influenced truth):

| model | P | R | F1 | silver-neg FP/50 |
|---|---|---|---|---|
| tfidf-word+LR | 0.864 | 0.415 | 0.560 | 8 |
| tfidf-word+SVM | 0.864 | 0.772 | 0.815 | 15 |
| tfidf-char+LR | 0.950 | 0.463 | 0.623 | 3 |

Learning curve (SVM, gold-eval, silver fraction 0.25→1.0): precision stays
1.000 throughout; recall falls 1.0→0.61 — more silver makes the model more
conservative, never less precise. Calibration bins on OOF probs are monotone
sane. Inference latency sub-millisecond/doc; full train <60s on 8 CPUs;
zero dependencies; <50MB RAM.

## 5. Precision/coverage trade-off (data-driven thresholds, NOT assumed)

From pooled OOF probabilities (Exp B): threshold 0.35–0.40 yields ~100%
precision at ~85–92% coverage for word models. Below 0.3, silver-trained
models dump mass (precision collapses to base rate 0.93 → baseline). The
operating point must be re-fit as gold labels accumulate; ship the curve,
not a number.

## 6. Comparison with GPT-OSS/Qwen (valid overlaps only)

- On the 37 human TRADING channels: both LLMs ~perfect (36–37/37) — agreement, not a win for either side.
- On 34 negatives (gpt-oss-120b supplementary run): 6 FP (17.6%), 0 abstentions, 28 correct. POC char-LR: 3/50 FP (6%); word-SVM: 15/50 (30%) on silver (model-influenced truth — same circularity caveat as the LLMs' training).
- Head-to-head verdict agreement qwen-vs-oss was 105/107; both abstain ~1% vs production Gemini's liberal abstention — the shared calibration risk.
- Honest summary: local models match-or-beat LLMs on false-positive AVOIDANCE at the cost of coverage (recall 0.08–0.77 vs LLMs ~1.0 on positives); LLMs dominate recall and need no training data.

## 7. Resources/latency

Pure-Python POC: <1ms inference, <60s train, stdlib only. Production shape
(sklearn/ONNX): single-digit ms, tens of MB, no GPU, no per-request cost,
fully offline. Embeddings track would add ~500MB weights + ~50–200ms/doc CPU.

## 8. Limitations and risks (read before recommending)

1. n=9 gold negatives: precision CIs are wide; one mislabeled negative moves everything.
2. Silver NON_TRADING is pipeline-influenced: Exp-B perfect precision may partly mirror incumbent quirks, not pure trading semantics.
3. Multilingual slices are tiny (arabic 1, cyrillic 1, cjk 3 channels): cross-script claims are descriptive, not proven. Embeddings untested.
4. No concept/citation/reasonCode outputs: a classifier returns a label + confidence only — downstream consumers of explanations/citations still need an LLM or a retrieval fallback.
5. Abstention policy is threshold-on-probability: uncalibrated on distributional shift; needs monitoring + gold re-fit loop.
6. Cold-start: a new language/domain with zero gold examples gets no guarantees.

## 9. Recommendation

YES, continue to a larger POC — but scoped: (a) collect 30–50 more gold negatives via the existing human review queue (highest leverage action; unlocks tight precision CIs); (b) run the embeddings + SetFit track where torch exists, same protocol; (c) prototype the abstention-gated hybrid (local decides ≥ threshold, else current LLM path) OFFLINE with replay measurement before any shadow discussion. Do NOT integrate, shadow, or route traffic on these numbers.

## 10. Experiment D — 6 model-disputed FPs as provisional gold negatives

Per 2026-09-06 instruction, the 6 LLM-disputed channels joined gold (41 pos + 15 neg eval pool, n=150 pooled OOF). Results at th=0.5: word+LR P=1.000/FP=0, word+SVM P=0.940/FP=5, char+LR P=1.000/FP=0. ALL FPs at every threshold come from the 6 provisional channels; the 3 original gold negatives are never misclassified by any model at any threshold. The provisional 6 carry 100% of the error mass — they are genuinely trading-smelling to every model family tested (TF-IDF and LLM alike), which is precisely why the pending human verdicts on them are the highest-leverage labels in the program. These 6 are PROVISIONAL pending human confirmation; if any flips to TRADING, reported precision rises.
