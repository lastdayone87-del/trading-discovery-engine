"""Multilingual-embeddings + SetFit track (REQUIRES torch runtime — see EMBEDDINGS_TRACK.md).

Not executed in the sandbox (no torch/weights). Same protocol as evaluate_labels.py
or the comparison is void: same dataset builder, same channel-held-out folds,
same seeds (2000+rep), same pooled-OOF reporting, same threshold curves.

Run where torch exists:
    pip install torch --index-url https://download.pytorch.org/whl/cpu
    pip install transformers sentence-transformers setfit datasets scikit-learn
    python3 evaluate_embeddings.py /tmp/poc_dataset.json

Subcommands mirror the TF-IDF tracks:
  Track A: multilingual-E5-small (or paraphrase-multilingual-MiniLM-L12-v2)
           mean-pooled + L2-normalized + poc.py LogisticRegression.
  Track B: SetFit contrastive fine-tuning on the MiniLM backbone.
"""

import json
import os
import statistics
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from poc import (  # noqa: E402
    doc_text, stratified_folds, prf, sigmoid, dot, train_lr,
)

try:
    import torch  # noqa: F401
    from sentence_transformers import SentenceTransformer
except Exception as exc:  # pragma: no cover - environment gate
    raise SystemExit(
        'torch/sentence-transformers unavailable in this runtime. '
        'See EMBEDDINGS_TRACK.md for the required environment. '
        f'Import error: {exc}'
    )

E5_MODEL = os.environ.get('E5_MODEL', 'intfloat/multilingual-e5-small')
SETFIT_BACKBONE = os.environ.get('SETFIT_BACKBONE', 'sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2')


def read_ids(name):
    with open(os.path.join(HERE, 'labels', name), encoding='utf8') as fh:
        return {l.strip() for l in fh if l.strip() and not l.startswith('#')}


def embed_texts(model, texts, prefix='query: '):
    import torch.nn.functional as F
    embs = model.encode(
        [prefix + t[:2000] for t in texts],
        normalize_embeddings=False, show_progress_bar=False,
        convert_to_numpy=False,
    )
    if not hasattr(embs, 'numpy'):
        import numpy as np
        embs = np.asarray(embs, dtype=float)
    else:
        embs = embs.numpy()
    norms = (embs ** 2).sum(axis=1, keepdims=True) ** 0.5 + 1e-12
    return embs / norms


def to_sparse_list(vec):
    return {i: float(v) for i, v in enumerate(vec) if v != 0.0}


def main(path, out_path='/tmp/emb_results.json'):
    rows = json.load(open(path, encoding='utf8'))
    pos_ids, neg_ids, excl = read_ids('positives.txt'), read_ids('negatives.txt'), read_ids('exclude.txt')
    rows = [r for r in rows if r['channel_id'] not in excl]
    texts = [doc_text(r) for r in rows]

    def gold(i):
        cid = rows[i]['channel_id']
        if cid in neg_ids:
            return 0
        if cid in pos_ids:
            return 1
        r = rows[i]
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

    model = SentenceTransformer(E5_MODEL)
    print(f'encoder: {E5_MODEL}')

    got = []
    for rep in range(3):
        folds = stratified_folds([yg[i] for i in gold_all], 5, seed=2000 + rep)
        for fi in range(5):
            te = [gold_all[i] for i in folds[fi]]
            tr = [gold_all[i] for f, fold in enumerate(folds) for i in fold if f != fi] + silver_neg
            Etr = embed_texts(model, [texts[i] for i in tr])
            Ete = embed_texts(model, [texts[i] for i in te])
            Xtr = [to_sparse_list(v) for v in Etr]
            w, b = train_lr(Xtr, [ys[i] for i in tr])
            for i, v in zip(te, Ete):
                got.append((i, sigmoid(dot(w, to_sparse_list(v), b))))
    oof = sorted(got)
    yt = [yg[i] for i, _ in oof]
    probs = [p for _, p in oof]
    prec, rec, f1, fp = prf(yt, [1 if p >= 0.5 else 0 for p in probs])
    print(f'e5+LR: P={prec:.3f} R={rec:.3f} F1={f1:.3f} FP={fp} n={len(yt)}')
    curve = []
    for th in [i / 100 for i in range(5, 100, 5)]:
        yp = [1 if p >= th else 0 for p in probs]
        pr, _, _, _ = prf(yt, yp)
        curve.append((th, round(pr, 3), round(sum(yp) / len(yp), 3)))
    print(f'  curve: {[(t, p, c) for t, p, c in curve if c > 0][:10]}')
    json.dump({'oof': oof, 'model': E5_MODEL},
              open(out_path, 'w'))


def run_setfit(path, out_path='/tmp/setfit_results.json'):
    """SetFit few-shot track. Same folds/seeds; requires the `setfit` package."""
    try:
        from datasets import Dataset
        from setfit import SetFitModel, SetFitTrainer
    except Exception as exc:
        raise SystemExit(f'setfit/datasets unavailable: {exc}. See EMBEDDINGS_TRACK.md.')
    rows = json.load(open(path, encoding='utf8'))
    pos_ids = read_ids('positives.txt')
    neg_ids = read_ids('negatives.txt')
    excl = read_ids('exclude.txt')
    rows = [r for r in rows if r['channel_id'] not in excl]
    texts = [doc_text(r) for r in rows]

    def gold(i):
        cid = rows[i]['channel_id']
        if cid in neg_ids:
            return 0
        if cid in pos_ids:
            return 1
        return None

    yg = [gold(i) for i in range(len(rows))]
    labeled = [i for i, g in enumerate(yg) if g is not None]
    got = []
    for rep in range(3):
        folds = stratified_folds([yg[i] for i in labeled], 5, seed=2000 + rep)
        for fi in range(5):
            te = [labeled[i] for i in folds[fi]]
            tr = [labeled[i] for f, fold in enumerate(folds) for i in fold if f != fi]
            train_ds = Dataset.from_dict({
                'text': [texts[i] for i in tr],
                'label': [yg[i] for i in tr],
            })
            eval_ds = Dataset.from_dict({
                'text': [texts[i] for i in te],
                'label': [yg[i] for i in te],
            })
            model = SetFitModel.from_pretrained(
                SETFIT_BACKBONE,
                labels=[0, 1],
                multi_target_strategy=None,
            )
            trainer = SetFitTrainer(
                model=model,
                train_dataset=train_ds,
                eval_dataset=eval_ds,
                metric='accuracy',
                num_iterations=5,
                num_epochs=1,
                batch_size=8,
                seed=7,
            )
            trainer.train()
            preds = model.predict([texts[i] for i in te])
            probs = model.predict_proba([texts[i] for i in te])
            pos_probs = [float(p[1]) for p in probs]
            for i, p in zip(te, pos_probs):
                got.append((i, p))
            _ = preds
    oof = sorted(got)
    yt = [yg[i] for i, _ in oof]
    probs = [p for _, p in oof]
    prec, rec, f1, fp = prf(yt, [1 if p >= 0.5 else 0 for p in probs])
    print(f'setfit: P={prec:.3f} R={rec:.3f} F1={f1:.3f} FP={fp} n={len(yt)}')
    json.dump({'oof': oof}, open(out_path, 'w'))


if __name__ == '__main__':
    which = sys.argv[2] if len(sys.argv) > 2 else 'e5'
    if which == 'setfit':
        run_setfit(sys.argv[1])
    else:
        main(sys.argv[1] if len(sys.argv) > 1 else '/tmp/poc_dataset.json')
