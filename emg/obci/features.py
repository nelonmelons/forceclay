"""Windowed EMG feature extraction -> labeled feature matrix for ML.

Turns a multi-channel recording (+ optional per-sample labels) into a table of
sliding-window features — the standard input to an EMG gesture classifier.

Features per window (classic Hudgins time-domain set + spectral extras), computed
on the notch+bandpass-filtered signal so 60 Hz hum and drift don't pollute them:
  mav, rms, wl (waveform length), zc (zero crossings), ssc (slope-sign changes),
  var, mnf (mean freq), mdf (median freq), bp_20_40 / bp_40_80 / bp_80_120 (band power)
"""
from __future__ import annotations

import numpy as np

from . import signal_processing as sp
from . import config

AR_ORDER = 4
FEATURE_NAMES = ["mav", "rms", "wl", "zc", "ssc", "var",
                 "mnf", "mdf", "bp_20_40", "bp_40_80", "bp_80_120"] + \
                [f"ar{i+1}" for i in range(AR_ORDER)]


def ar_coeffs(x, order=AR_ORDER):
    """Autoregressive model coefficients (predict x[t] from prior `order` samples) —
    a classic EMG feature capturing waveform shape that amplitude misses."""
    x = np.asarray(x, dtype=float)
    n = x.size
    if n <= order:
        return [0.0] * order
    A = np.column_stack([x[order - 1 - k: n - 1 - k] for k in range(order)])
    b = x[order:n]
    try:
        coef, *_ = np.linalg.lstsq(A, b, rcond=None)
        return [float(c) for c in coef]
    except Exception:
        return [0.0] * order


def slope_sign_changes(x, threshold: float = 1.0) -> int:
    """Count direction reversals of the signal slope (noise dead-zone in uV)."""
    x = np.asarray(x, dtype=float)
    if x.size < 3:
        return 0
    d1 = x[1:-1] - x[:-2]
    d2 = x[1:-1] - x[2:]
    sig = (d1 * d2) > 0
    big = (np.abs(d1) > threshold) | (np.abs(d2) > threshold)
    return int(np.sum(sig & big))


def mean_median_freq(x, fs):
    """Spectral fatigue/shape features: mean and median power frequency (Hz)."""
    f, pxx = sp._psd(x, fs)
    tot = float(np.sum(pxx))
    if tot <= 0 or f.size < 2:
        return 0.0, 0.0
    mnf = float(np.sum(f * pxx) / tot)
    cum = np.cumsum(pxx)
    mdf = float(f[np.searchsorted(cum, cum[-1] / 2.0)])
    return mnf, mdf


def window_features(x, fs) -> dict:
    """All features for one window of one channel (filtered internally).

    Computes the PSD ONCE and reuses it for mean/median freq + all band powers
    (was 4 redundant Welch transforms on the identical signal).
    """
    pre = sp.preprocess_emg(np.asarray(x, dtype=float), fs)   # 60 Hz notch + 20-100 band
    f, pxx = sp._psd(pre, fs)                                 # single PSD, reused below
    nyq = fs / 2.0
    tot = float(np.sum(pxx))
    if tot > 0 and f.size > 1:
        mnf = float(np.sum(f * pxx) / tot)
        cum = np.cumsum(pxx)
        mdf = float(f[np.searchsorted(cum, cum[-1] / 2.0)])
    else:
        mnf = mdf = 0.0

    def band(lo, hi):
        hi = min(hi, nyq)
        if lo >= nyq:
            return 0.0
        idx = (f >= lo) & (f <= hi)
        return float(np.trapezoid(pxx[idx], f[idx])) if np.any(idx) else 0.0

    return {
        "mav": sp.mean_absolute_value(pre),
        "rms": sp.rms(pre),
        "wl": sp.waveform_length(pre),
        "zc": float(sp.zero_crossings(pre, threshold=1.0)),
        "ssc": float(slope_sign_changes(pre, threshold=1.0)),
        "var": float(np.var(pre)),
        "mnf": mnf,
        "mdf": mdf,
        "bp_20_40": band(20, 40),
        "bp_40_80": band(40, 80),
        "bp_80_120": band(80, min(120, nyq - 1)),
        **{f"ar{i+1}": c for i, c in enumerate(ar_coeffs(pre))},
    }


def feature_columns(channels) -> list:
    """The ordered feature-column names for a given set of channels."""
    return [f"ch{ch}_{name}" for ch in sorted(channels) for name in FEATURE_NAMES]


def _segments(label, rep, phase):
    """Yield (start, end, lbl, rp, ph) for each contiguous (label,rep,phase) run."""
    n = len(label)
    i = 0
    while i < n:
        j = i
        while (j < n and label[j] == label[i] and rep[j] == rep[i] and phase[j] == phase[i]):
            j += 1
        yield i, j, label[i], rep[i], phase[i]
        i = j


def _onset_region(x, fs):
    """Trim a 'move' segment to where the muscle actually fired (restimulus-style).

    Returns (lo, hi) sample indices of the active region, correcting the
    reaction-time lag between the cue and real EMG onset.
    """
    env = sp.emg_envelope(sp.preprocess_emg(np.asarray(x, float), fs), fs)
    if env.size < 4:
        return 0, len(x)
    floor = np.percentile(env, 20)
    thr = floor + 0.30 * (env.max() - floor)        # 30% up from floor to peak
    active = np.where(env > thr)[0]
    if active.size < int(0.1 * fs):
        return 0, len(x)
    return int(active[0]), int(active[-1]) + 1


# --- data-quality + robustness helpers --------------------------------------
def session_scale(x, fs):
    """Robust per-channel amplitude reference (MVC proxy) = 95th pct of the
    moving-RMS envelope. Dividing by it makes amplitude comparable across
    sessions/electrode placements, killing cross-session amplitude drift."""
    env = sp.emg_envelope(sp.preprocess_emg(np.asarray(x, float), fs), fs)
    s = float(np.percentile(env, 95)) if env.size else 0.0
    return s if s > 1e-6 else 1.0


def window_ok(x_raw, fs, max_rail=0.02, min_std=1.0, max_line=0.5):
    """Quality gate on the RAW window: reject flat/dead, railing, mains-dominated."""
    x = np.asarray(x_raw, float)
    if x.size < 8 or np.std(x) < min_std:
        return False
    if np.mean(np.abs(x) > 0.9 * config.FULL_SCALE_UV) > max_rail:
        return False
    lr = sp.line_noise_ratio(x, fs)
    return not (lr is not None and lr > max_line)


def augment_window(x, rng):
    """Plausible raw-window augmentation: amplitude scale + jitter + mild
    time-warp. TRAINING windows only (never test)."""
    x = np.asarray(x, float)
    y = x * rng.uniform(0.8, 1.2)                                     # contraction strength
    y = y + rng.normal(0.0, 0.05 * (np.std(x) + 1e-6), size=y.shape)  # sensor jitter
    if x.size >= 16 and rng.random() < 0.5:                          # mild time-warp
        idx = np.clip((np.arange(x.size) * rng.uniform(0.85, 1.15)).astype(int), 0, x.size - 1)
        y = y[idx]
    return y


def windows_from_session(df, fs, channels, win_s: float = config.EMG_WINDOW_S,
                         hop_s: float = config.EMG_HOP_S,
                         keep_center: float = 0.6, relabel_onset: bool = True,
                         drop_phases=("prep", "idle"), normalize: bool = False,
                         quality: bool = True, label_check: bool = True,
                         contract_factor: float = 2.0, augment: int = 0,
                         calib: str = "full"):
    # NOTE: normalize defaults OFF — ablation showed per-session normalization
    # HURTS on a single channel (amplitude is a real cue). Revisit when multi-channel.
    """Segment-aware windowing for a CUED session (label/rep/phase columns).

    Ninapro hygiene + data-quality layer:
      - drop prep/transition phases; onset-relabel 'move'; keep segment centers
      - per-session per-channel normalization (MVC proxy)   [normalize]
      - reject railing/flat/mains windows                   [quality]
      - drop 'move' windows where the muscle didn't fire    [label_check]
      - optional `augment` synthetic copies/window (train-only; tagged aug>0)
    Returns features + columns: label, rep, aug, t_start_s. Test code must keep
    only aug==0 rows.
    """
    import pandas as pd

    label = df["label"].to_numpy()
    rep = df["rep"].to_numpy() if "rep" in df else np.zeros(len(df), int)
    phase = df["phase"].to_numpy() if "phase" in df else np.array(["move"] * len(df))
    raw = {ch: df[f"ch_{ch}"].to_numpy(float) for ch in channels if f"ch_{ch}" in df}
    chs = sorted(raw)
    # scale source: "full" peeks at the whole session (incl. the gesture windows we
    # later classify -> transductive). "rest" uses only the rest baseline, a per-
    # session calibration you'd actually have before classifying -> causal/leak-free.
    rest_m = (df["label"].to_numpy() == "rest")
    def _scale(ch):
        if not normalize:
            return 1.0
        src = raw[ch][rest_m] if (calib == "rest" and rest_m.sum() > int(win_s * fs)) else raw[ch]
        return session_scale(src, fs)
    scale = {ch: _scale(ch) for ch in chs}
    norm = {ch: raw[ch] / scale[ch] for ch in chs}
    primary = chs[0]
    rest_ref = 0.0
    if label_check:
        env = sp.emg_envelope(sp.preprocess_emg(norm[primary], fs), fs)
        m = (label == "rest")
        rest_ref = float(np.median(env[m])) if m.any() else float(np.percentile(env, 20))
    w, h = max(8, int(win_s * fs)), max(1, int(hop_s * fs))
    rng = np.random.default_rng(0)
    rows = []
    for s, e, lbl, rp, ph in _segments(label, rep, phase):
        if ph in drop_phases:
            continue
        lo, hi = s, e
        if relabel_onset and ph == "move":
            olo, ohi = _onset_region(norm[primary][s:e], fs)
            lo, hi = s + olo, s + ohi
        if hi - lo < w:
            continue
        margin = int((1 - keep_center) / 2 * (hi - lo))
        for start in range(lo + margin, hi - margin - w + 1, h):
            sl = slice(start, start + w)
            if quality and not all(window_ok(raw[ch][sl], fs) for ch in chs):
                continue
            if label_check and ph == "move":
                e_env = sp.emg_envelope(sp.preprocess_emg(norm[primary][sl], fs), fs)
                if e_env.mean() < max(rest_ref * contract_factor, 0.05):
                    continue                                          # gesture didn't fire
            base = {ch: norm[ch][sl] for ch in chs}

            def featrow(getwin, aug):
                row = {"label": lbl, "rep": int(rp), "aug": aug, "t_start_s": start / fs}
                for ch in chs:
                    for name, val in window_features(getwin(ch), fs).items():
                        row[f"ch{ch}_{name}"] = val
                return row

            rows.append(featrow(lambda ch: base[ch], 0))
            for k in range(augment):
                rows.append(featrow(lambda ch, _k=k: augment_window(base[ch], rng), k + 1))
    return pd.DataFrame(rows)


def extract_feature_matrix(channels: dict, fs, labels=None,
                           win_s: float = config.EMG_WINDOW_S, hop_s: float = config.EMG_HOP_S,
                           min_label_frac: float = 0.6):
    """Slide a window over the recording -> DataFrame of per-window features.

    channels: {ch -> 1-D uV array} (all same length).
    labels:   per-sample label array (object/str) or None.
    Returns a pandas DataFrame: t_start_s, ch{n}_{feat}..., and `label` if given
    (windows whose dominant label covers < min_label_frac of the window are dropped).
    """
    import pandas as pd

    chs = sorted(channels)
    n = int(min(len(channels[ch]) for ch in chs))
    w = max(8, int(win_s * fs))
    h = max(1, int(hop_s * fs))
    rows = []
    for start in range(0, n - w + 1, h):
        sl = slice(start, start + w)
        row = {"t_start_s": start / fs}
        for ch in chs:
            for name, val in window_features(channels[ch][sl], fs).items():
                row[f"ch{ch}_{name}"] = val
        if labels is not None:
            seg = np.asarray(labels[sl])
            vals, counts = np.unique(seg, return_counts=True)
            if counts.max() >= min_label_frac * w:
                row["label"] = vals[np.argmax(counts)]
            else:
                row["label"] = None
        rows.append(row)
    df = pd.DataFrame(rows)
    if labels is not None and "label" in df:
        df = df[df["label"].notna()].reset_index(drop=True)
    return df
