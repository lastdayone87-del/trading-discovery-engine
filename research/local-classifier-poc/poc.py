"""Research-only offline POC: local trading-channel classifiers (stdlib only).

Compares TF-IDF + Logistic Regression / Linear SVM (Pegasos) / char-TFIDF + LR
on human/silver labels. Embeddings + SetFit are specified as unrunnable here
(no torch/weights runtime); see README notes in the final report.
"""
import json, math, random, re, time
from collections import Counter

SEED = 7

def load_rows():
    return json.load(open('/tmp/opencode/poc/dataset.json'))

def doc_text(row):
    ni = row['input'] if isinstance(row['input'], dict) else json.loads(row['input'])
    parts = [ni.get('channel_name', ''), ni.get('description', ''),
             ' '.join(ni.get('video_titles') or []), ' '.join(ni.get('video_descriptions') or [])]
    return ' '.join(p for p in parts if p)

def gold_label(row):
    if row['human_decision'] == 'APPROVE' or row['user_confirmed_trading']:
        return 1
    if row['human_decision'] == 'REJECT' or row['trading_status'] == 'HUMAN_REJECTED':
        return 0
    return None

def silver_label(row):
    g = gold_label(row)
    if g is not None:
        return g
    if row['trading_status'] == 'NON_TRADING':
        return 0
    return None

def word_tokens(text):
    return re.findall(r'[^\W_]+', text.lower(), flags=re.UNICODE)

def char_tokens(text, n=4):
    t = re.sub(r'\s+', ' ', text.lower()).strip()
    return [t[i:i+n] for n in (3, 4, 5) for i in range(max(0, len(t)-n+1))]

class Tfidf:
    def __init__(self, tok, min_df=2, max_feat=20000):
        self.tok, self.min_df, self.max_feat = tok, min_df, max_feat
    def fit(self, docs):
        df = Counter()
        for d in docs:
            for t in set(self.tok(d)):
                df[t] += 1
        vocab = [t for t, c in df.items() if c >= self.min_df]
        vocab.sort(key=lambda t: -df[t])
        self.vocab = {t: i for i, t in enumerate(vocab[:self.max_feat])}
        n = len(docs)
        self.idf = {t: math.log((1 + n) / (1 + df[t])) + 1.0 for t in self.vocab}
        return self
    def transform(self, docs):
        out = []
        for d in docs:
            tf = Counter(t for t in self.tok(d) if t in self.vocab)
            norm = math.sqrt(sum(((1 + math.log(c)) * self.idf[t]) ** 2 for t, c in tf.items())) or 1.0
            out.append({self.vocab[t]: ((1 + math.log(c)) * self.idf[t]) / norm for t, c in tf.items()})
        return out

def dot(w, x, b=0.0):
    return b + sum(w.get(i, 0.0) * v for i, v in x.items())

def train_lr(X, y, l2=1.0, iters=150, lr=0.5):
    w, b = {}, 0.0
    n = len(X)
    for _ in range(iters):
        gw, gb = {}, 0.0
        for x, t in zip(X, y):
            p = 1.0 / (1.0 + math.exp(-max(-50.0, min(50.0, dot(w, x, b)))))
            e = p - t
            for i, v in x.items():
                gw[i] = gw.get(i, 0.0) + e * v
            gb += e
        for i in list(gw):
            gw[i] = gw[i] / n + l2 * w.get(i, 0.0) / n
        gb /= n
        for i, g in gw.items():
            w[i] = w.get(i, 0.0) - lr * g
        b -= lr * gb
    return w, b

def train_pegasos(X, y, lam=0.01, iters=800, seed=SEED):
    rnd = random.Random(seed)
    w, b, t = {}, 0.0, 0
    n = len(X)
    for _ in range(iters):
        t += 1
        eta = 1.0 / (lam * t)
        i = rnd.randrange(n)
        x, s = X[i], 1.0 if y[i] == 1 else -1.0
        if s * dot(w, x, b) < 1.0:
            for j, v in x.items():
                w[j] = (1 - eta * lam) * w.get(j, 0.0) + eta * s * v
            b += eta * s
        else:
            for j in list(w):
                w[j] *= (1 - eta * lam)
    return w, b

def sigmoid(z):
    return 1.0 / (1.0 + math.exp(-max(-50.0, min(50.0, z))))

def stratified_folds(y, k, seed):
    rnd = random.Random(seed)
    idx = {0: [], 1: []}
    for i, t in enumerate(y):
        idx[t].append(i)
    for t in idx:
        rnd.shuffle(idx[t])
    folds = [[] for _ in range(k)]
    for t in (0, 1):
        for j, i in enumerate(idx[t]):
            folds[j % k].append(i)
    return folds

def prf(y_true, y_pred):
    tp = sum(1 for a, b in zip(y_true, y_pred) if a == 1 and b == 1)
    fp = sum(1 for a, b in zip(y_true, y_pred) if a == 0 and b == 1)
    fn = sum(1 for a, b in zip(y_true, y_pred) if a == 1 and b == 0)
    prec = tp / (tp + fp) if tp + fp else 0.0
    rec = tp / (tp + fn) if tp + fn else 0.0
    return prec, rec, 2 * prec * rec / (prec + rec) if prec + rec else 0.0, fp
