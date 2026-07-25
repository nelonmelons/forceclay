"""Live co-adaptation engine (Phase 1 of the co-adaptation experiment).

Holds the closed-loop state for the server:
  - PREQUENTIAL: predict each incoming window BEFORE it's learned (predict->log->
    reveal->update), so the accuracy readout is always leak-free.
  - incremental retrain on the accumulating labeled buffer.
  - a 2-D LDA projection (cluster view + live point) so the human can SEE where their
    current gesture lands vs the class clusters and steer toward separation.
  - Fisher-ratio separability (the frozen-model probe foundation).

See the vault note 'EMG - Co-Adaptation Experiment (Step 2)'.
"""
from __future__ import annotations
import threading
from collections import deque

import numpy as np
import pandas as pd

from . import decoder as D
from .features import window_features


def fisher_ratio(X, y):
    Xs = (X - X.mean(0)) / (X.std(0) + 1e-8)
    mu = Xs.mean(0); Sb = Sw = 0.0
    for k in np.unique(y):
        Xk = Xs[y == k]; d = Xk.mean(0) - mu
        Sb += len(Xk) * float(d @ d); Sw += float(((Xk - Xk.mean(0)) ** 2).sum())
    return Sb / (Sw + 1e-9)


def lda_axes(Xs, y):
    """Top-2 LDA discriminant directions in standardized feature space."""
    d = Xs.shape[1]; mu = Xs.mean(0)
    Sb = np.zeros((d, d)); Sw = np.zeros((d, d))
    for k in np.unique(y):
        Xk = Xs[y == k]; m = (Xk.mean(0) - mu)[:, None]
        Sb += len(Xk) * (m @ m.T)
        Xc = Xk - Xk.mean(0); Sw += Xc.T @ Xc
    M = np.linalg.pinv(Sw + np.eye(d) * 1e-6) @ Sb
    w, V = np.linalg.eig(M)
    idx = np.argsort(-w.real)[:2]
    return V[:, idx].real


class CoAdapt:
    def __init__(self, retrain_every=25, warmup=40, maxbuf=4000):
        self.lock = threading.Lock()
        self.retrain_every = retrain_every
        self.warmup = warmup
        self.maxbuf = maxbuf
        self.reset()

    def reset(self):
        with self.lock:
            self.on = False
            self.target = None
            self.rows, self.labels = [], []
            self.model, self.cols = None, None
            self.preq = deque(maxlen=80)     # recent predict-before-learn correctness
            self.sep = 0.0
            self._axes = None                # (mu, sd, W2) for live projection
            self.proj, self.cent, self.live = [], {}, None
            self.n = 0

    def start(self):
        with self.lock: self.on = True

    def stop(self):
        with self.lock: self.on = False

    def set_target(self, label):
        with self.lock: self.target = label or None

    def ingest(self, windows, fs):
        """windows: {channel -> 1-D uV array of one window}. Called from the acquire loop."""
        with self.lock:
            on, target = self.on, self.target
        if not on or not target:
            return
        row = {}
        for ch, w in windows.items():
            for name, val in window_features(np.asarray(w, float), fs).items():
                row[f"ch{ch}_{name}"] = val
        with self.lock:
            model, cols, axes = self.model, self.cols, self._axes
        # prequential: predict BEFORE this window is learned
        if model is not None and cols:
            try:
                pr = D.predict(model, pd.DataFrame([row]))[0]
                with self.lock:
                    self.preq.append(1.0 if pr == target else 0.0)
            except Exception:
                pass
        # live projection of the current window (so the dot moves in real time)
        if axes is not None and cols:
            mu, sd, W2 = axes
            x = np.array([row.get(c, 0.0) for c in cols], float)
            p = ((x - mu) / sd) @ W2
            with self.lock:
                self.live = [round(float(p[0]), 3), round(float(p[1]), 3)]
        # buffer + periodic incremental retrain
        with self.lock:
            self.rows.append(row); self.labels.append(target)
            if len(self.rows) > self.maxbuf:
                self.rows = self.rows[-self.maxbuf:]; self.labels = self.labels[-self.maxbuf:]
            self.n = len(self.rows)
            do = self.n >= self.warmup and self.n % self.retrain_every == 0
            snap = (list(self.rows), list(self.labels)) if do else None
        if snap:
            self._retrain(*snap)

    def _retrain(self, rows, labels):
        bdf = pd.DataFrame(rows); bdf["label"] = labels
        if bdf["label"].nunique() < 2:
            return
        cols = [c for c in bdf.columns if c != "label"]
        try:
            model = D.train(bdf, cols)
            X = np.nan_to_num(bdf[cols].to_numpy(float)); y = bdf["label"].to_numpy()
            mu, sd = X.mean(0), X.std(0) + 1e-8
            Xs = (X - mu) / sd
            W2 = lda_axes(Xs, y)
            P = Xs @ W2
        except Exception:
            return
        cent = {str(k): [round(float(P[y == k, 0].mean()), 3), round(float(P[y == k, 1].mean()), 3)]
                for k in np.unique(y)}
        step = max(1, len(P) // 400)
        proj = [[round(float(P[i, 0]), 3), round(float(P[i, 1]), 3), str(y[i])]
                for i in range(0, len(P), step)]
        sep = fisher_ratio(X, y)
        with self.lock:
            self.model, self.cols, self._axes = model, cols, (mu, sd, W2)
            self.proj, self.cent, self.sep = proj, cent, sep

    def state(self):
        with self.lock:
            preq = (sum(self.preq) / len(self.preq)) if self.preq else None
            counts = {}
            for l in self.labels:
                counts[l] = counts.get(l, 0) + 1
            return {"on": self.on, "target": self.target, "n": self.n,
                    "preq": round(preq * 100, 1) if preq is not None else None,
                    "preq_n": len(self.preq), "sep": round(self.sep, 3),
                    "proj": self.proj, "cent": self.cent, "live": self.live, "counts": counts}
