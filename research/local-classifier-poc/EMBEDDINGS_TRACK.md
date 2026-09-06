# Embeddings + SetFit track — SPECIFIED, NOT EXECUTED

Status: blocked on runtime, not on design. The sandbox offers only CPython
3.14 on Android: no torch wheels, Termux repos unreachable, nested proot
denied. Nothing below was run; no numbers here are results.

## Environment required

Linux x86_64/aarch64 (non-Android), Python 3.10–3.12,
`torch --index-url https://download.pytorch.org/whl/cpu`,
`transformers sentence-transformers setfit datasets scikit-learn`,
~3 GB disk (torch ~200MB + `paraphrase-multilingual-MiniLM-L12-v2` ~500MB),
HuggingFace Hub egress for the one-time weight download.

## Protocol (identical to the TF-IDF tracks or the comparison is void)

1. Same dataset (`fetch_dataset.cjs`), same channel-held-out folds, same seeds
   (1000+rep / 2000+rep / 3000+rep / 4000+rep as in evaluate*.py).
2. Track A — multilingual embeddings + LR: `multilingual-E5-small`
   (or MiniLM-L12-v2 if E5 underperforms on short bios), mean-pooled,
   L2-normalized, pure-Python LR from `poc.py` (same iters/l2) on top.
   Rationale: semantic generalization beyond keywords; E5-small is ~120M
   params, ~50–200ms/doc CPU.
3. Track B — SetFit: `setfit` trainer on MiniLM backbone, 5–20 contrastive
   iterations, same folds; compare F1/precision at matched coverage.
4. Same reports: pooled-OOF P/R/F1/FP, threshold curve, calibration bins,
   per-script slices, learning curves, latency (encode + inference split).
5. Abstention policy is shared: thresholds re-fit per model on OOF probs;
   never copy TF-IDF thresholds across.

## Why these two and not others

- E5-small/MiniLM: smallest multilingual encoders with credible cross-script
  transfer; anything larger (BGE-M3, F2LLM-v2-80M) buys latency/weight cost
  without evidence on this n≈50 task.
- SetFit: explicitly built for few-shot text classification; the only
  fine-tuning approach that does not demand hundreds of labels.
- Skipped with reason: full fine-tuning (needs 10–100× labels), LLM
  distillation-as-training (circular with the incumbent), ONNX in sandbox
  (no runtime to convert or execute).

## Go/no-go for this track

Run it where torch exists with the commands above. If embeddings do not beat
TF-IDF+SVM F1 by a margin that survives the tiny-n confidence intervals,
prefer the zero-dependency linear models.
