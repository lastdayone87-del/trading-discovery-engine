"""Experiment C (all-labeled CV) + multilingual slices + learning curves."""
import json, random, statistics
from poc import (load_rows, doc_text, silver_label, word_tokens,
                 char_tokens, Tfidf, train_lr, train_pegasos, sigmoid, dot,
                 stratified_folds, prf)

random.seed(7)
rows = load_rows()
texts = [doc_text(r) for r in rows]
ys = [silver_label(r) for r in rows]
idx_all = [i for i, s in enumerate(ys) if s is not None]

def script_of(t):
    nolat = sum(1 for ch in t if ord(ch) > 127)
    if nolat == 0:
        return 'latin'
    import re
    if re.search(r'[\u0400-\u04FF]', t):
        return 'cyrillic'
    if re.search(r'[\u0600-\u06FF]', t):
        return 'arabic'
    if re.search(r'[\u4E00-\u9FFF\u3040-\u30FF\uAC00-\uD7AF]', t):
        return 'cjk'
    if re.search(r'[\u0900-\u097F]', t):
        return 'devanagari'
    return 'other-nolatin'

slices = [script_of(texts[i]) for i in idx_all]
print('SCRIPT SLICES:', {s: slices.count(s) for s in set(slices)})

MODELS = {
    'tfidf-word+LR': (lambda: Tfidf(word_tokens), 'lr'),
    'tfidf-word+SVM': (lambda: Tfidf(word_tokens), 'svm'),
    'tfidf-char+LR': (lambda: Tfidf(char_tokens), 'lr'),
}

def run_once(y, tr_extra=None, repeats=3, k=5, tag=''):
    res = {m: [] for m in MODELS}
    for rep in range(repeats):
        folds = stratified_folds(y, k, seed=3000 + rep)
        for fi in range(k):
            te = folds[fi]
            tr = [i for f, fold in enumerate(folds) for i in fold if f != fi]
            if tr_extra:
                tr = tr + tr_extra
            for m, (mk, kind) in MODELS.items():
                v = mk().fit([texts[i] for i in tr])
                Xtr = v.transform([texts[i] for i in tr])
                ytr = [y[i] for i in tr]
                w, b = (train_lr(Xtr, ytr) if kind == 'lr' else train_pegasos(Xtr, ytr))
                for i in te:
                    x = v.transform([texts[i]])[0]
                    res[m].append((i, sigmoid(dot(w, x, b))))
    return res

yy = [ys[i] for i in idx_all]
res = run_once(yy, tag='C')
for m in MODELS:
    oof = sorted(res[m])
    yt = [yy[i] for i, _ in oof]
    probs = [p for _, p in oof]
    prec, rec, f1, fp = prf(yt, [1 if p >= 0.5 else 0 for p in probs])
    print(f'{m}: P={prec:.3f} R={rec:.3f} F1={f1:.3f} FP={fp}')
    # FP on silver negatives only
    fpn = sum(1 for i, p in oof if ys[i] == 0 and p >= 0.5)
    print(f'  silver-neg FP: {fpn}/50')
    # per-slice agreement
    for s in sorted(set(slices)):
        ii = [i for i, sl in zip(idx_all, slices) if sl == s]
        oo = [(i, p) for i, p in oof if i in set(ii)]
        if oo:
            a = sum(1 for i, p in oo if (1 if p >= 0.5 else 0) == ys[i]) / len(oo)
            print(f'  slice {s}: acc={a:.3f} n={len(oo)}')

# learning curve: silver-train fractions, gold-eval (reuse Exp-B shape, word+SVM only for speed)
print('--- learning curve (tfidf-word+SVM, gold-eval) ---')
yg = __import__('poc').gold_label
gold_all = [i for i, r in enumerate(rows) if yg(r) is not None]
silver_neg = [i for i in idx_all if yg(rows[i]) is None]
for frac in (0.25, 0.5, 0.75, 1.0):
    import random as R
    R.seed(11)
    sub = sorted(R.sample(silver_neg, max(1, int(len(silver_neg) * frac))))
    res2 = run_once([yg(rows[i]) for i in gold_all], tr_extra=None, repeats=2, k=5, tag='') if False else None
    # manual: folds over gold_all indices mapped through yg
    got = []
    for rep in range(2):
        folds = stratified_folds([yg(rows[i]) for i in gold_all], 5, seed=4000 + rep)
        for fi in range(5):
            te = [gold_all[i] for i in folds[fi]]
            tr = [gold_all[i] for f, fold in enumerate(folds) for i in fold if f != fi] + sub
            v = Tfidf(word_tokens).fit([texts[i] for i in tr])
            Xtr = v.transform([texts[i] for i in tr])
            w, b = train_pegasos(Xtr, [silver_label(rows[i]) for i in tr])
            for i in te:
                got.append((i, sigmoid(dot(w, v.transform([texts[i]])[0], b))))
    oof = sorted(got)
    prec, rec, f1, fp = prf([yg(rows[i]) for i, _ in oof], [1 if p >= 0.5 else 0 for _, p in oof])
    print(f'  silver_frac={frac}: P={prec:.3f} R={rec:.3f} F1={f1:.3f} FP={fp}')
