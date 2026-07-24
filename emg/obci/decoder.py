"""Decoder: the ONE canonical train / evaluate / persist layer for EMG models.

Shared by train_gesture.py (CLI) and live_server.py (auto-retrain) so there's a
single implementation of: session loading -> features, the LDA classifier,
leave-one-group-out evaluation (by repetition or by session), model I/O, and the
active-learning hint. Keep the foundation here as we add channels/gestures later.
"""
from __future__ import annotations

import json

import numpy as np

from . import features as F
from . import config


# ----------------------------------------------------------------- classifier
class LDA:
    """Gaussian LDA with a shared, regularized within-class covariance."""

    def fit(self, X, y, balanced=False):
        self.classes = np.unique(y)
        n, d = X.shape
        K = len(self.classes)
        self.mu, self.prior = {}, {}
        Sw = np.zeros((d, d))
        for k in self.classes:
            Xk = X[y == k]
            self.mu[k] = Xk.mean(0)
            # balanced: uniform priors so a rare class (e.g. clench in few sessions)
            # isn't penalized by frequency; else empirical priors.
            self.prior[k] = (1.0 / K) if balanced else (len(Xk) / n)
            Xc = Xk - self.mu[k]
            Sw += Xc.T @ Xc
        Sw /= max(1, n - len(self.classes))
        Sw += np.eye(d) * (1e-3 * np.trace(Sw) / d + 1e-9)
        self.Sinv = np.linalg.pinv(Sw)
        self.w = {k: self.Sinv @ self.mu[k] for k in self.classes}
        self.b = {k: -0.5 * self.mu[k] @ self.w[k] + np.log(self.prior[k]) for k in self.classes}
        return self

    def scores(self, X):
        return np.stack([X @ self.w[k] + self.b[k] for k in self.classes], axis=1)

    def predict(self, X):
        return self.classes[np.argmax(self.scores(X), axis=1)]


# ----------------------------------------------------------------- data -> features
def session_features(path, channels, win_s=config.EMG_WINDOW_S, hop_s=config.EMG_HOP_S, augment=0,
                     normalize=False, calib="full"):
    """One session parquet -> feature DataFrame (label, rep, aug, __src + features)."""
    import pandas as pd

    df = pd.read_parquet(path)
    if "label" not in df:
        raise ValueError(f"{path}: no 'label' column (not a labeled session)")
    fs = 250.0
    try:
        fs = float(json.loads(open(str(path) + ".meta.json").read()).get("fs", 250.0))
    except Exception:
        pass
    if not any(f"ch_{ch}" in df for ch in channels):
        raise ValueError(f"{path}: none of channels {channels} present")
    if "rep" in df.columns or "phase" in df.columns:        # cued -> segment-aware
        feat = F.windows_from_session(df, fs, channels, win_s=win_s, hop_s=hop_s,
                                      augment=augment, normalize=normalize, calib=calib)
    else:                                                    # legacy per-sample labels
        chans = {ch: df[f"ch_{ch}"].to_numpy(float) for ch in channels if f"ch_{ch}" in df}
        feat = F.extract_feature_matrix(chans, fs, labels=df["label"].to_numpy(),
                                        win_s=win_s, hop_s=hop_s)
        feat["rep"] = 0
        feat["aug"] = 0
    feat["__src"] = str(path).split("/")[-1]
    return feat


def load_sessions(paths, channels, win_s=config.EMG_WINDOW_S, hop_s=config.EMG_HOP_S, augment=0,
                  normalize=False, calib="full"):
    import pandas as pd
    frames = [session_features(p, channels, win_s, hop_s, augment, normalize, calib) for p in paths]
    return pd.concat(frames, ignore_index=True)


def feature_cols(df, channels):
    return [c for c in F.feature_columns(channels) if c in df.columns]


def _to_xy(df, cols):
    X = np.nan_to_num(df[cols].to_numpy(float), nan=0.0, posinf=0.0, neginf=0.0)
    return X, df["label"].to_numpy()


# ----------------------------------------------------------------- train / eval
def train(df, cols, balanced=True):
    """Fit standardizer + LDA on all rows. Returns a portable model dict.
    balanced=True uses uniform class priors (default) — robust to class/session imbalance."""
    X, y = _to_xy(df, cols)
    mu, sd = X.mean(0), X.std(0) + 1e-8
    clf = LDA().fit((X - mu) / sd, y, balanced=balanced)
    classes = [str(c) for c in clf.classes]
    return {"classes": classes, "cols": list(cols), "mu": mu, "sd": sd,
            "W": np.stack([clf.w[k] for k in clf.classes]),
            "B": np.array([clf.b[k] for k in clf.classes])}


def predict(model, df):
    X = np.nan_to_num(df[model["cols"]].to_numpy(float), nan=0.0, posinf=0.0, neginf=0.0)
    s = (X - model["mu"]) / model["sd"] @ model["W"].T + model["B"]
    return np.array(model["classes"])[np.argmax(s, axis=1)]


def predict_proba(model, df):
    """Returns (labels, max-softmax-confidence) — confidence drives the reject option."""
    X = np.nan_to_num(df[model["cols"]].to_numpy(float), nan=0.0, posinf=0.0, neginf=0.0)
    s = (X - model["mu"]) / model["sd"] @ model["W"].T + model["B"]
    e = np.exp(s - s.max(axis=1, keepdims=True))
    p = e / e.sum(axis=1, keepdims=True)
    k = np.argmax(p, axis=1)
    return np.array(model["classes"])[k], p[np.arange(len(p)), k]


def confusion(y_true, y_pred, classes):
    idx = {c: i for i, c in enumerate(classes)}
    M = np.zeros((len(classes), len(classes)), int)
    for t, p in zip(y_true, y_pred):
        if t in idx and p in idx:
            M[idx[t], idx[p]] += 1
    return M


def choose_grouping(df):
    """Pick the honest, leak-free split available: session > repetition > random.

    Leave-one-session-out is only valid if EVERY session contains multiple
    classes — otherwise holding one out drops an entire gesture from training
    (its recall collapses to 0). If sessions are single-gesture, fall back to
    pooled leave-one-repetition-out so all classes stay in every fold.
    """
    if "__src" in df and df["__src"].nunique() > 1:
        # valid only if every class appears in >=2 sessions, so holding one out
        # still leaves that class in training (else its recall collapses to 0)
        if (df.groupby("label")["__src"].nunique() >= 2).all():
            return "__src", "leave-one-session-out"
        # else: a gesture lives in only one session -> use reps instead
    reps = [r for r in df["rep"].unique() if int(r) > 0] if "rep" in df else []
    if len(reps) >= 2:
        return "rep", "leave-one-repetition-out (pooled across sessions)"
    return None, "random-split (optimistic — one group only)"


def evaluate(df, cols, group, reject_thresh=0.6):
    """Leave-one-group-out CV. Tests on real (aug==0) rows only; trains on all
    (incl. augmented). Returns mean/std acc, confusion, and a reject-option
    metric (accuracy + coverage when confidence >= reject_thresh)."""
    classes = sorted(str(c) for c in df["label"].unique())
    agg = np.zeros((len(classes), len(classes)), int)
    accs, folds, conf_all, corr_all = [], [], [], []
    if group is None:                                   # random stratified fallback
        rng = np.random.default_rng(0)
        y = df["label"].to_numpy()
        te = []
        for k in np.unique(y):
            idx = np.where(y == k)[0]
            rng.shuffle(idx)
            te += idx[int(0.7 * len(idx)):].tolist()
        mask = np.zeros(len(df), bool); mask[np.array(te)] = True
        groups = [("holdout", df[mask], df[~mask])]
    else:
        groups = [(g, df[df[group] == g], df[df[group] != g])
                  for g in sorted(df[group].unique())]
    for g, test, train_df in groups:
        if "aug" in test.columns:
            test = test[test["aug"] == 0]               # never test on synthetic rows
        if len(test) == 0 or len(np.unique(train_df["label"])) < 2:
            continue
        m = train(train_df, cols)
        yp, conf = predict_proba(m, test)
        yt = test["label"].to_numpy()
        accs.append(float(np.mean(yp == yt)))
        folds.append((g, accs[-1], len(test)))
        agg += confusion(yt, yp, classes)
        conf_all.append(conf); corr_all.append(yp == yt)
    reject = None
    if conf_all:
        conf = np.concatenate(conf_all); corr = np.concatenate(corr_all)
        keep = conf >= reject_thresh
        reject = {"thresh": reject_thresh, "coverage": float(np.mean(keep)),
                  "acc": float(np.mean(corr[keep])) if keep.any() else 0.0}
    return {"classes": classes, "confusion": agg, "folds": folds,
            "mean": float(np.mean(accs)) if accs else 0.0,
            "std": float(np.std(accs)) if accs else 0.0, "reject": reject}


def active_learning_hint(conf, classes):
    """From the confusion matrix, say what to record more of next."""
    M = conf.copy()
    np.fill_diagonal(M, 0)
    if M.sum() == 0:
        return "no confusions — add a new gesture, or vary placement/sessions for robustness."
    i, j = np.unravel_index(np.argmax(M), M.shape)
    recall = {classes[k]: (conf[k].sum() and conf[k, k] / conf[k].sum()) for k in range(len(classes))}
    worst = min(recall, key=recall.get)
    return (f"most-confused: '{classes[i]}' read as '{classes[j]}' ({M[i, j]}x) · "
            f"weakest class: '{worst}' ({recall[worst]*100:.0f}% recall) · "
            f"record a focused run of those next.")


# ----------------------------------------------------------------- model I/O
def save_model(model, path):
    np.savez(path, classes=np.array(model["classes"]), cols=np.array(model["cols"]),
             mu=model["mu"], sd=model["sd"], W=model["W"], B=model["B"])
    return str(path)


def load_model(path):
    d = np.load(path, allow_pickle=True)
    return {"classes": [str(c) for c in d["classes"]], "cols": [str(c) for c in d["cols"]],
            "mu": d["mu"], "sd": d["sd"], "W": d["W"], "B": d["B"]}


def report_text(ev, hint=None):
    classes, M = ev["classes"], ev["confusion"]
    w = max(7, max((len(c) for c in classes), default=7) + 1)
    lines = [f"{ev['folds'] and 'LOGO' or ''} mean acc {ev['mean']*100:.1f}% ± {ev['std']*100:.1f}%  (n={int(M.sum())})"]
    lines.append(" " * (w + 8) + "  ".join(f"{c:>{w}}" for c in classes))
    for i, c in enumerate(classes):
        lines.append(f"  true {c:>{w}}  " + "  ".join(f"{M[i,j]:>{w}d}" for j in range(len(classes))))
    if ev.get("reject"):
        r = ev["reject"]
        lines.append(f"reject@{r['thresh']:.2f}: {r['acc']*100:.1f}% accuracy at {r['coverage']*100:.0f}% coverage")
    if hint:
        lines.append("next: " + hint)
    return "\n".join(lines)


def write_manifest(paths, df, out):
    """Snapshot the training dataset (versioning / reproducibility)."""
    import time
    real = df[df["aug"] == 0] if "aug" in df else df
    man = {"version": time.strftime("%Y%m%d_%H%M%S", time.localtime()),
           "n_sessions": len(paths), "sessions": [str(p).split("/")[-1] for p in paths],
           "classes": sorted(str(c) for c in real["label"].unique()),
           "windows_per_class": {str(k): int(v) for k, v in real["label"].value_counts().items()},
           "n_windows_real": int(len(real)), "n_windows_total": int(len(df))}
    open(out, "w").write(json.dumps(man, indent=2))
    return man
