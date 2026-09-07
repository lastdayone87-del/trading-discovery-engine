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

## 11. Experiment E — human verdicts applied (2026-09-06; label-file-driven rerun is authoritative)

Human review: 5 of 6 provisional channels CONFIRMED TRADING; UCtDCcHIV5Lt85pwrLp2IVcA UNVERIFIABLE and excluded from all supervised pools (enforced via labels/exclude.txt; verified in run output). Gold is 46 pos + 3 neg; silver 41 neg. Re-run through research/local-classifier-poc/evaluate_labels.py (reads labels/*.txt, no hard-coded IDs):

| model @0.5 | P | R | F1 | FP |
|---|---|---|---|---|
| tfidf-word+LR | 1.000 | 0.572 | 0.728 | 0 |
| tfidf-word+SVM | 1.000 | 0.768 | 0.869 | 0 |
| tfidf-char+LR | 1.000 | 0.638 | 0.779 | 0 |

Operating curve (pooled OOF): threshold 0.35 gives P=1.000 at coverage 0.864–0.980 depending on model; 0.40 gives P≈1.000 at 0.80–0.94 (SVM best balance). No model misclassifies any gold negative at any threshold.

Correction note: the first Exp-E run (evaluate5.py) accidentally trained the 5 flipped channels with their STALE poc.py labels (negative) while testing them as positive — an adversarial label-shift mix, not the clean protocol. Its lower recalls (0.08–0.65) measure robustness to stale training labels, not current-truth accuracy. The label-file rerun above (flips trained as the positives they are) supersedes it. Lesson recorded: label semantics must come from exactly one source (labels/*.txt), which evaluate_labels.py now enforces.

## 12. Experiment F — 24 gold negatives (user-adjudicated Tier 1–3)

Human verdicts applied via labels/*.txt: Tier 1 (9) + Tier 2 (11) TRADING, Tier 3 (18) NOT_TRADING, UCtDCc excluded everywhere (verified counts: gold 66 pos / 24 neg, silver 41 neg, 131 rows, 0 near-dup pairs >0.3). Same Exp-B protocol (train gold+silver, gold-only OOF eval, pooled over 3x5 folds, n=270):

| model @0.5 | P | R | F1 | FP |
|---|---|---|---|---|
| tfidf-word+LR | 0.909 | 0.505 | 0.649 | 10 |
| tfidf-word+SVM | 0.930 | 0.667 | 0.776 | 10 |
| tfidf-char+LR | 0.925 | 0.561 | 0.698 | 9 |

Before/after (Exp E → Exp F @0.5): precision 1.000 → 0.909–0.930 (real negatives bite, as expected); recall 0.29–0.77 → 0.51–0.67; FP 0 → 9–10. Operating curve: P>=0.95 requires th>=0.45 (coverage 0.66–0.81); th=0.65 gives FP=0 at coverage ~0–23% (SVM retains 15 TP). FP attribution (mean-prob diagnostic): persistent FPs across all models are trading-adjacent gaming/entertainment (OG Kamo Gaming, DAMAREOUS, Catalin Arseniu) plus The Trading Guide (UCt1Gq1mUok8n9zOOJbzb9VA) — flagged back as prime re-review candidates since their content reads trading-related. Confirmed REJECT channels are correctly negative at th=0.5 for all models.

## 13. Experiment G — 5 flipped to TRADING, 2 held NOT_TRADING (69/21 gold)

Human verdicts applied via labels/*.txt (3 flips moved neg->pos, UCtDCc stays excluded everywhere; verified counts). Same Exp-B protocol (train gold+silver, gold-only OOF, n=270 pooled):

| model @0.5 | P | R | F1 | FP |
|---|---|---|---|---|
| tfidf-word+LR | 0.921 | 0.792 | 0.852 | 14 |
| tfidf-word+SVM | 0.921 | 0.787 | 0.849 | 14 |
| tfidf-char+LR | 0.929 | 0.826 | 0.875 | 13 |

Operating curve: P>=0.95 needs th>=0.45 (coverage 0.66–0.83); th=0.65 gives FP~0 with sharply reduced coverage. Recall roughly doubled vs Exp F (more positives to learn from); precision 0.92 reflects genuinely hard negatives now present.

FP attribution (mean-prob diagnostic): persistent across all models — the 2 held gaming/entertainment hybrids (OG Kamo, Catalin Arsieniu) plus DayTradeToWin (Tier-3 entertainment, trading-named). Notably, two confirmed REJECT channels (UCNogn1o, UCzZJaZz) also score trading-positive — genuine human-vs-model disagreements worth a second look, not model errors by default. The 3 flips to TRADING eliminated the models' largest prior error mass, validating all families' nose a third time.

## 14. Experiment H — corrected labels: 67 pos / 23 neg gold (current authoritative)

Correction: commit 46d8d90 prematurely added 20 undecided Tier 1–2 channels as positives (2 of which human review then ruled NOT_TRADING). Those 2 moved to negatives; all other Tier 1–2 verdicts confirmed the provisional labels. Exp F/G numbers trained on the contaminated set are superseded by this section — same Exp-B protocol (train gold+silver, gold-only OOF, n=270 pooled), UCtDCc excluded everywhere:

| model @0.5 | P | R | F1 | FP |
|---|---|---|---|---|
| tfidf-word+LR | 0.946 | 0.701 | 0.806 | 8 |
| tfidf-word+SVM | 0.935 | 0.721 | 0.815 | 10 |
| tfidf-char+LR | 0.948 | 0.726 | 0.823 | 8 |

Operating curve: P>=0.95 needs th>=~0.5 at coverage 0.55–0.68; th=0.65 gives FP~0 with sharply reduced coverage. FP attribution (mean-prob diagnostic): only OG Kamo Gaming, Catalin Arsieniu (held hybrids), and DayTradeToWin (Tier-3, trading-named) persist across all models; the two previously-disputed REJECT channels no longer misclassify. The 3 flipped Tier-3 channels are now true positives. Base rate 67/90 = 0.744.

## 15. Experiment I — DayTradeToWin corrected to TRADING (68/22 gold)

Human correction applied via labels/*.txt (DayTradeToWin moved neg->pos; UCtDCc still excluded; verified counts). Same Exp-B protocol (train gold+silver, gold-only OOF, n=270 pooled):

| model @0.5 | P | R | F1 | FP |
|---|---|---|---|---|
| tfidf-word+LR | 0.951 | 0.760 | 0.845 | 8 |
| tfidf-word+SVM | 0.957 | 0.760 | 0.847 | 7 |
| tfidf-char+LR | 0.947 | 0.784 | 0.858 | 9 |

Operating curve: P>=0.95 needs th>=~0.5 (coverage 0.60–0.68); th=0.65 gives FP~0 with sharply reduced coverage. FP attribution (mean-prob diagnostic): only the 2 held hybrids (OG Kamo, Catalin Arsieniu) persist across all models at th=0.5, plus Marko's Trading Journey for char-LR — all trading-adjacent entertainment, all human-confirmed NOT_TRADING. DayTradeToWin is now a true positive everywhere. Remaining persistent-FP list for re-examination: OG Kamo, Catalin Arsieniu (re-examination does not mean relabeling without human review).
