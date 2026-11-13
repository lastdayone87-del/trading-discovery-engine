"""Experiment D: 6 model-disputed FPs promoted to provisional gold negatives.

Per user instruction 2026-09-06: treat these 6 as the next gold-negative batch
(PROVISIONAL — pending human verdict confirmation). Everything else identical
to the Exp-B protocol: train gold+silver, evaluate gold-only, pooled OOF.
"""
import json, statistics, time
from poc import (load_rows, doc_text, gold_label, silver_label, word_tokens,
                 char_tokens, Tfidf, train_lr, train_pegasos, sigmoid, dot,
                 stratified_folds, prf)

MODELS = {
    'tfidf-word+LR': (lambda: Tfidf(word_tokens), 'lr'),
    'tfidf-word+SVM': (lambda: Tfidf(word_tokens), 'svm'),
    'tfidf-char+LR': (lambda: Tfidf(char_tokens), 'lr'),
}

def fit_predict(vec, kind, tr_texts, tr_y, te_texts):
    v = vec.fit(tr_texts)
    Xtr = v.transform(tr_texts)
    if kind == 'lr':
        w, b = train_lr(Xtr, tr_y)
    else:
        w, b = train_pegasos(Xtr, tr_y)
    Xte = v.transform(te_texts)
    return [sigmoid(dot(w, x, b)) for x in Xte], 0.0

PROVISIONAL_NEG = {
    'UC8htzD4B8clPgQ49jLyUI0g', 'UCnyiCKGE57Ug9_oczQMa-Kw',
    'UCtDCcHIV5Lt85pwrLp2IVcA', 'UCaXumdSCaUSH3PIxS8QLXtg',
    'UCqLKXv-s8UvLyscTMeKUbhQ', 'UCy9-W-75rFCge1cwqzFeBUg',
}

rows = load_rows()
texts = [doc_text(r) for r in rows]
cids = [r['channel_id'] for r in rows]

assert all(any(r['channel_id'] == c for r in rows) for c in PROVISIONAL_NEG), 'FP channel missing from dataset'

def gold2(i):
    if cids[i] in PROVISIONAL_NEG:
        return 0
    return gold_label(rows[i])

yg = [gold2(i) for i in range(len(rows))]
ys = [silver_label(rows[i]) for i in range(len(rows))]
gold_all = [i for i, g in enumerate(yg) if g is not None]
silver_neg = [i for i, (g, s) in enumerate(zip(yg, ys)) if g is None and s == 0]
print(f'GOLD: pos={sum(yg[i] for i in gold_all)} neg={len(gold_all)-sum(yg[i] for i in gold_all)} silver_neg={len(silver_neg)}')

for m, (mk, kind) in MODELS.items():
    got = []
    for rep in range(3):
        folds = stratified_folds([yg[i] for i in gold_all], 5, seed=2000 + rep)
        for fi in range(5):
            te = [gold_all[i] for i in folds[fi]]
            tr = [gold_all[i] for f, fold in enumerate(folds) for i in fold if f != fi] + silver_neg
            probs, _ = fit_predict(mk(), kind, [texts[i] for i in tr], [ys[i] for i in tr], [texts[i] for i in te])
            got.extend(zip(te, probs))
    oof = sorted(got)
    yt = [yg[i] for i, _ in oof]
    probs = [p for _, p in oof]
    prec, rec, f1, fp = prf(yt, [1 if p >= 0.5 else 0 for p in probs])
    print(f'{m}: P={prec:.3f} R={rec:.3f} F1={f1:.3f} FP={fp} n={len(yt)}')
    curve = []
    for th in [i / 100 for i in range(5, 100, 5)]:
        yp = [1 if p >= th else 0 for p in probs]
        pr, _, _, _ = prf(yt, yp)
        curve.append((th, round(pr, 3), round(sum(yp) / len(yp), 3)))
    print(f'  curve: {[(t, p, c) for t, p, c in curve if c > 0][:10]}')
    # FP attribution: provisional vs original gold negatives
    for th in (0.35, 0.5):
        bad = [cids[i] for i, p in oof if p >= th and yg[i] == 0]
        print(f'  th={th} FPs: {len(bad)} prov={[c for c in bad if c in PROVISIONAL_NEG]} orig={[c for c in bad if c not in PROVISIONAL_NEG]}')
