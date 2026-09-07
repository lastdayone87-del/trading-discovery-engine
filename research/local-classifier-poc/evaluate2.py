"""Experiment B/C: silver-augmented training, gold-only (primary) + silver (secondary) eval."""
import json, random, statistics, time
from poc import (load_rows, doc_text, gold_label, silver_label, word_tokens,
                 char_tokens, Tfidf, train_lr, train_pegasos, sigmoid, dot,
                 stratified_folds, prf)

random.seed(7)
rows = load_rows()
texts = [doc_text(r) for r in rows]
yg = [gold_label(r) for r in rows]
ys = [silver_label(r) for r in rows]

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
    t0 = time.time()
    probs = [sigmoid(dot(w, x, b)) for x in Xte]
    ms = (time.time() - t0) / max(1, len(Xte)) * 1000
    return probs, ms

def report(name, yt, probs):
    prec, rec, f1, fp = prf(yt, [1 if p >= 0.5 else 0 for p in probs])
    print(f'{name}: P={prec:.3f} R={rec:.3f} F1={f1:.3f} FP={fp} n={len(yt)}')
    curve = []
    for th in [i / 100 for i in range(5, 100, 5)]:
        yp = [1 if p >= th else 0 for p in probs]
        pr, _, _, _ = prf(yt, yp)
        curve.append((th, round(pr, 3), round(sum(yp) / len(yp), 3)))
    print(f'  curve: {[(t, p, c) for t, p, c in curve if c > 0][:10]}')
    bins = {}
    for t, p in zip(yt, probs):
        b = min(9, int(p * 10))
        bins.setdefault(b, [0, 0])
        bins[b][1] += 1
        bins[b][0] += t
    print(f'  cal: { {b: round(v[0]/v[1], 2) for b, v in sorted(bins.items())} }')

def run(name, test_idx, train_pool_fn, repeats=3, k=5):
    print(f'=== {name} ===')
    res = {m: [] for m in MODELS}
    ms = {m: [] for m in MODELS}
    for rep in range(repeats):
        folds = stratified_folds([yg[i] for i in test_idx], k, seed=2000 + rep)
        for fi in range(k):
            te = [test_idx[i] for i in folds[fi]]
            tr_gold = [test_idx[i] for f, fold in enumerate(folds) for i in fold if f != fi]
            tr = train_pool_fn(tr_gold)
            for m, (mk, kind) in MODELS.items():
                probs, dt = fit_predict(mk(), kind, [texts[i] for i in tr], [ys[i] for i in tr], [texts[i] for i in te])
                res[m].extend(zip(te, probs))
                ms[m].append(dt)
    for m in MODELS:
        oof = sorted(res[m])
        report(f'{m} [med {statistics.median(ms[m]):.1f}ms/doc]', [yg[i] for i, _ in oof], [p for _, p in oof])

gold_pos = [i for i, g in enumerate(yg) if g == 1]
gold_neg = [i for i, g in enumerate(yg) if g == 0]
gold_all = gold_pos + gold_neg
silver_neg = [i for i, (g, s) in enumerate(zip(yg, ys)) if g is None and s == 0]

# B: test on gold only; train = outer-train gold + ALL silver negatives
run('EXP-B gold-eval/silver-train', gold_all, lambda tr: tr + silver_neg)
