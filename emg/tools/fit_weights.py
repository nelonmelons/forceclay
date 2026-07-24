"""Fit per-channel weights for the force axis from a labelled session.

The weights in emg_server.RealEmgSource.DEFAULT_WEIGHTS are specific to one
electrode placement. Anyone with a different montage should refit, because a
single bad channel changes the answer a lot -- and the right answer is not
"use the best channel".

Record a session with tools/live_server.py (rest + clench labels, a few reps),
then:

    python tools/fit_weights.py recordings/session_*.parquet

It prints the weights plus the Fisher separability of every candidate axis, so
you can see whether weighting is actually buying you anything on YOUR data.

Fisher ratio, not the median rest/clench ratio, is the metric: a big median
ratio on a channel whose rest floor wanders is useless for control, and Fisher
accounts for the variance that a ratio hides.
"""
from __future__ import annotations

import argparse
import glob
import sys
from pathlib import Path

import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))  # emg/ -> obci
from obci import config
from obci import signal_processing as sp


def fisher(sig: np.ndarray, a: np.ndarray, b: np.ndarray) -> float:
    """Separability of two labelled masks: squared mean gap over pooled variance."""
    x, y = sig[a], sig[b]
    if x.size == 0 or y.size == 0:
        return float("nan")
    return float((y.mean() - x.mean()) ** 2 / (x.var() + y.var() + 1e-12))


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("sessions", nargs="+", help="recordings/session_*.parquet (globs ok)")
    ap.add_argument("--rest", default="rest", help="label for the resting class")
    ap.add_argument("--active", default="clench", help="label for the contracted class")
    ap.add_argument("--fs", type=float, default=None, help="override sampling rate")
    args = ap.parse_args()

    paths = sorted({p for pat in args.sessions for p in glob.glob(pat)})
    if not paths:
        print("no sessions matched", file=sys.stderr)
        return 1
    df = pd.concat([pd.read_parquet(p) for p in paths], ignore_index=True)
    fs = args.fs or config.BOARD_SAMPLING_RATE.get(config.DEFAULT_BOARD, 250)

    chans = sorted(int(c.split("_")[1]) for c in df.columns if c.startswith("ch_"))
    lab = df["label"].to_numpy()
    rest, act = lab == args.rest, lab == args.active
    if not rest.any() or not act.any():
        print(f"need both '{args.rest}' and '{args.active}' labels; found "
              f"{sorted(set(lab))}", file=sys.stderr)
        return 1

    print(f"{len(paths)} session(s), {len(df)} samples @ {fs:g} Hz, channels {chans}")
    print(f"  {args.rest}={rest.sum()}  {args.active}={act.sum()}\n")

    env = {c: sp.emg_envelope(sp.preprocess_emg(df[f"ch_{c}"].to_numpy(float), fs), fs)
           for c in chans}

    # Screen out channels that are not actually live. A powered-down or unwired
    # channel sits near-constant, and LDA will happily hand it a large weight: its
    # slow drift acts as a CLOCK, and because rest/active are recorded as separate
    # time blocks a clock separates them perfectly. That is leakage, not signal.
    live = [c for c in chans
            if np.median(env[c][act]) / max(np.median(env[c][rest]), 1e-9) > 1.5]
    dropped = [c for c in chans if c not in live]
    if dropped:
        print(f"  dropped as not-live (active/rest ratio < 1.5): ch{dropped}")
    if not live:
        print("no live channels found", file=sys.stderr)
        return 1
    chans = live

    print(f"{'channel':<10}{'rest':>10}{'active':>10}{'ratio':>9}{'Fisher':>9}")
    for c in chans:
        r, a = np.median(env[c][rest]), np.median(env[c][act])
        print(f"ch{c:<8}{r:8.2f}uV{a:8.2f}uV{a / max(r, 1e-9):8.1f}x"
              f"{fisher(env[c], rest, act):9.2f}")

    # LDA on log-envelopes: EMG amplitude is roughly log-normal, so the log makes
    # the two classes closer to Gaussian with a shared covariance, which is exactly
    # the assumption LDA's closed form needs.
    X = np.column_stack([np.log(env[c] + 1e-6) for c in chans])

    def fit(mask_r, mask_a):
        mu0, mu1 = X[mask_r].mean(0), X[mask_a].mean(0)
        n0, n1 = mask_r.sum(), mask_a.sum()
        S = (np.cov(X[mask_r].T) * n0 + np.cov(X[mask_a].T) * n1) / (n0 + n1)
        S = np.atleast_2d(S)
        v = np.linalg.solve(S + 1e-9 * np.eye(len(chans)), np.atleast_1d(mu1 - mu0))
        return v / max(np.abs(v).sum(), 1e-12)

    w = fit(rest, act)

    cands = {"best single": max((fisher(env[c], rest, act), f"ch{c}", env[c])
                                for c in chans)[2],
             "unweighted sum": sum(env[c] for c in chans),
             "LDA log-env": X @ w}
    print(f"\n{'axis':<18}{'in-sample':>11}{'LORO CV':>10}")

    # Leave-one-rep-out: fit on all but one repetition, score on the held-out one.
    # Fitting and scoring the same samples inflates every axis, and inflates the
    # multi-channel ones most because they have more free parameters to overfit.
    reps = df["rep"].to_numpy() if "rep" in df else np.zeros(len(df), int)
    uniq = [r for r in sorted(set(reps.tolist())) if ((reps == r) & rest).any()
            and ((reps == r) & act).any()]

    def loro(build):
        out = []
        for r in uniq:
            tr, te = reps != r, reps == r
            sig = build(tr)
            out.append(fisher(sig, te & rest, te & act))
        return float(np.nanmean(out)) if out else float("nan")

    for name, sig in cands.items():
        if name == "LDA log-env":
            cv = loro(lambda tr: X @ fit(tr & rest, tr & act))
        else:
            cv = loro(lambda tr, _s=sig: _s)
        print(f"{name:<18}{fisher(sig, rest, act):11.2f}{cv:10.2f}")
    if len(uniq) < 2:
        print("  (only one usable rep -> LORO CV is not meaningful)")

    print("\nDEFAULT_WEIGHTS = {" +
          ", ".join(f"{c}: {v:+.3f}" for c, v in zip(chans, w)) + "}")
    neg = [c for c, v in zip(chans, w) if v < 0]
    if neg:
        print(f"  note: ch{neg} took a negative weight -- highly correlated with a "
              f"positive channel, so it subtracts as a common-mode reference. Keep it.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
