"""POC evaluation: repeated stratified CV with pooled out-of-fold predictions."""
import json, random, statistics, time
from poc import (load_rows, doc_text, gold_label, silver_label, word_tokens,
                 char_tokens, Tfidf, train_lr, train_pegasos, sigmoid, dot,
                 stratified_folds, prf)

random.seed(7)
rows = load_rows()
texts = [doc_text(r) for r in rows]
cids = [r['channel_id'] for r in rows]

# --- near-duplicate audit (shingle Jaccard) ---
def shingles(t, n=5):
    toks = word_tokens(t)
    return {' '.join(toks[i:i+n]) for i in range(max(0, len(toks)-n+1))} or {'<empty>'}

def jacc(a, b):
    return len(a & b) / len(a | b) if a | b else 0.0

sh = [shingles(t) for t in texts]
top = []
for i in range(len(texts)):
    for j in range(i+1, len(texts)):
        s = jacc(sh[i], sh[j])
        if s > 0.3:
            top.append((round(s, 3), cids[i][:10], cids[j][:10],
                        gold_label(rows[i]), gold_label(rows[j])))
top.sort(reverse=True)
print('NEAR-DUP PAIRS jacc>0.3:', len(top))
for t in top[:10]:
    print(' ', t)

MODELS = {
    'tfidf-word+LR': (lambda: Tfidf(word_tokens), 'lr'),
    'tfidf-word+SVM': (lambda: Tfidf(word_tokens), 'svm'),
    'tfidf-char+LR': (lambda: Tfidf(char_tokens), 'lr'),
}

def run_experiment(name, y, repeats=3, k=5):
    print(f'=== {name} n={len(y)} pos={sum(y)} neg={len(y)-sum(y)} ===')
    agg = {m: {'oof': [], 'times': [], 'f1s': [], 'precs': []} for m in MODELS}
    for rep in range(repeats):
        folds = stratified_folds(y, k, seed=1000 + rep)
        for fi in range(k):
            te = folds[fi]
            tr = [i for f, fold in enumerate(folds) for i in fold if f != fi]
            for m, (mkvec, kind) in MODELS.items():
                t0 = time.time()
                vec = mkvec().fit([texts[i] for i in tr])
                Xtr = vec.transform([texts[i] for i in tr])
                ytr = [y[i] for i in tr]
                if kind == 'lr':
                    w, b = train_lr(Xtr, ytr)
                    probs = [sigmoid(dot(w, x, b)) for x in vec.transform([texts[i] for i in te])]
                else:
                    w, b = train_pegasos(Xtr, ytr)
                    probs = [sigmoid(dot(w, x, b)) for x in vec.transform([texts[i] for i in te])]
                dt = (time.time() - t0) / max(1, len(te)) * 1000
                agg[m]['oof'].extend(zip(te, probs))
                agg[m]['times'].append(dt)
    for m in MODELS:
        oof = sorted(agg[m]['oof'])
        probs = [p for _, p in oof]
        yt = [y[i] for i, _ in oof]
        prec, rec, f1, fp = prf(yt, [1 if p >= 0.5 else 0 for p in probs])
        # threshold sweep for precision targets
        ths = [i/100 for i in range(5, 100, 5)]
        curve = []
        for th in ths:
            yp = [1 if p >= th else 0 for p in probs]
            pr, rc, _, _ = prf(yt, yp)
            curve.append((th, round(pr, 3), round(sum(yp)/len(yp), 3)))
        # calibration bins
        bins = {}
        for t, p in zip(yt, probs):
            b = min(9, int(p * 10))
            bins.setdefault(b, [0, 0])
            bins[b][1] += 1
            bins[b][0] += t
        cal = {b: round(v[0]/v[1], 2) for b, v in sorted(bins.items())}
        print(f'{m}: P={prec:.3f} R={rec:.3f} F1={f1:.3f} FP={fp} ms/doc={statistics.median(agg[m]["times"]):.1f}')
        print(f'  thresh curve (th,prec,cov): {[(t,p,c) for t,p,c in curve if c>0][:8]}')
        print(f'  calibration (bin:posrate): {cal}')
    return agg

ygold = [gold_label(r) for r in rows]
gold_idx = [i for i, g in enumerate(ygold) if g is not None]
run_experiment('GOLD-ONLY', [ygold[i] for i in gold_idx])

ysil = [silver_label(r) for r in rows]
sil_idx = [i for i, g in enumerate(ysil) if g is not None]
print('SILVER pool:', len(sil_idx))
