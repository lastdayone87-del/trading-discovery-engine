# Research-only POC: local trading-channel classifiers (DO NOT USE IN PRODUCTION)

Isolated offline experiments. Nothing here is imported, invoked, or referenced
by production code. No production behavior depends on this directory.

## Running

Requires only CPython 3.9+ standard library (no numpy/torch/sklearn — the
sandbox had no ML wheels, so TF-IDF, logistic regression, and Pegasos SVM are
implemented from scratch in `poc.py`):

```
cd research/local-classifier-poc
python3 evaluate.py    # Experiment A/B entry points (see report)
python3 evaluate2.py   # silver-augmented training, gold-only eval
python3 evaluate3.py   # all-labeled CV, slices, learning curves
```

Dataset (`dataset.json`, NOT committed — rebuild instruction below) is a
91-channel export: latest `normalized_input` per channel plus label tiers.
It contains human-reviewed channel data; treat it as sensitive evaluation
material, do not publish it raw.

## Rebuilding the dataset (read-only production SELECTs)

See `docs/research-local-classifier-poc.md` § "Ground-truth audit" for the
label-tier definitions and the exact queries. Requires the read-only auditor
role only.

## What was deliberately NOT run here

- `multilingual embeddings + Logistic Regression`: needs torch +
  sentence-transformers weights (e.g. paraphrase-multilingual-MiniLM-L12-v2
  or multilingual-E5). Environment interface is specified in the report; bring
  a Python with torch to run it.
- `SetFit` / FastFit: needs transformers + torch + datasets. Same note.
- No embedding or few-shot-transformer numbers are reported anywhere in this
  PR — any such numbers would be fabricated. The report marks these tracks
  unevaluated, not unsuccessful.
