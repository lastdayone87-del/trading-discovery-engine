"""Label-file-driven rerun of the Exp-B protocol (gold-eval, silver-train).

Usage:
  1. node fetch_dataset.js /tmp/poc_dataset.json   # read-only rebuild
  2. python3 evaluate_labels.py /tmp/poc_dataset.json
  3. Append new channel_ids to labels/positives.txt or labels/negatives.txt,
     then repeat. No code edits needed for new verdicts.

Skips labeled ids lacking inputs (reported). Excluded ids never enter pools.
"""
import json
import os
import statistics
import sys
from poc import (doc_text, word_tokens, char_tokens, Tfidf, train_lr,
                 train_pegasos, sigmoid, dot, stratified_folds, prf)

HERE = os.path.dirname(os.path.abspath(__file__))


def read_ids(name):
    with open(os.path.join(HERE, 'labels', name), encoding='utf8') as fh:
        return {l.strip() for l in fh if l.strip() and not l.startswith('#')}

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
    return [sigmoid(dot(w, x, b)) for x in Xte]


def main(path):
    rows = json.load(open(path, encoding='utf8'))
    pos_ids = read_ids('positives.txt')
    neg_ids = read_ids('negatives.txt')
    excl_ids = read_ids('exclude.txt')
    rows = [r for r in rows if r['channel_id'] not in excl_ids]
    print(f'rows after exclusion: {len(rows)}')
    texts = [doc_text(r) for r in rows]

    def gold(i):
        cid = rows[i]['channel_id']
        if cid in neg_ids:
            return 0
        if cid in pos_ids:
            return 1
        r = rows[i]
        if r.get('human_negative'):
            return 0
        if r.get('user_confirmed_trading') or r.get('human_decision') == 'APPROVE':
            return 1
        if r.get('human_decision') == 'REJECT' or r.get('trading_status') == 'HUMAN_REJECTED':
            return 0
        return None

    def silver(i):
        g = gold(i)
        if g is not None:
            return g
        return 0 if rows[i].get('trading_status') == 'NON_TRADING' else None

    yg = [gold(i) for i in range(len(rows))]
    ys = [silver(i) for i in range(len(rows))]
    gold_all = [i for i, g in enumerate(yg) if g is not None]
    silver_neg = [i for i, (g, s) in enumerate(zip(yg, ys)) if g is None and s == 0]
    print(f'GOLD: pos={sum(yg[i] for i in gold_all)} neg={len(gold_all)-sum(yg[i] for i in gold_all)} '
          f'silver_neg={len(silver_neg)} rows={len(rows)}')
    for m, (mk, kind) in MODELS.items():
        got = []
        for rep in range(3):
            folds = stratified_folds([yg[i] for i in gold_all], 5, seed=2000 + rep)
            for fi in range(5):
                te = [gold_all[i] for i in folds[fi]]
                tr = [gold_all[i] for f, fold in enumerate(folds) for i in fold if f != fi] + silver_neg
                probs = fit_predict(mk(), kind, [texts[i] for i in tr], [ys[i] for i in tr], [texts[i] for i in te])
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


if __name__ == '__main__':
    main(sys.argv[1] if len(sys.argv) > 1 else '/tmp/poc_dataset.json')
