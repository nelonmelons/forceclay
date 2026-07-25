"""CLI: train + honestly evaluate an EMG gesture model from labeled sessions.

Thin wrapper over obci.decoder (the shared train/eval/persist core, also used by
live_server.py for auto-retrain). Evaluation is leak-free by default: leave-one-
session-out if multiple sessions, else leave-one-repetition-out, else a random
split (flagged as optimistic).

    python train_gesture.py                       # all recordings/session_*.parquet
    python train_gesture.py A.parquet B.parquet --channels 1 --save-model g.npz
    python train_gesture.py train.parquet --test heldout.parquet
"""
from __future__ import annotations

import argparse
import glob

import numpy as np

import sys as _sys, pathlib as _pathlib
_sys.path.insert(0, str(_pathlib.Path(__file__).resolve().parent.parent))  # emg/ -> obci

from obci import decoder as D
from obci import config


def main():
    ap = argparse.ArgumentParser(description="Train EMG gesture model from labeled sessions")
    ap.add_argument("sessions", nargs="*", help="session parquets (default: recordings/session_*.parquet)")
    ap.add_argument("--channels", default="1", help="comma list, e.g. 1 or 1,2,3")
    ap.add_argument("--test", nargs="*", default=None, help="held-out session(s) for eval")
    ap.add_argument("--win", type=float, default=config.EMG_WINDOW_S)
    ap.add_argument("--hop", type=float, default=config.EMG_HOP_S)
    ap.add_argument("--save-model", default=None)
    ap.add_argument("--normalize", action="store_true",
                    help="per-session per-channel amplitude normalization (MVC proxy)")
    ap.add_argument("--calib", choices=["full", "rest"], default="full",
                    help="normalize scale source: 'full' (whole session, transductive) "
                         "or 'rest' (rest baseline only, causal/leak-free)")
    args = ap.parse_args()

    channels = [int(c) for c in args.channels.split(",") if c.strip()]
    paths = args.sessions or sorted(glob.glob(str(config.DATA_DIR / "session_*.parquet")))
    if not paths:
        raise SystemExit("No session_*.parquet found. Record some with live_server.py first.")

    df = D.load_sessions(paths, channels, args.win, args.hop, normalize=args.normalize, calib=args.calib)
    cols = D.feature_cols(df, channels)
    print(f"channels={channels}  win={args.win}s hop={args.hop}s  feature_dims={len(cols)}")
    print(f"sessions: {[p.split('/')[-1] for p in paths]}")
    print(f"windows/class: {df['label'].value_counts().to_dict()}")

    if args.test:
        test = D.load_sessions(args.test, channels, args.win, args.hop, normalize=args.normalize, calib=args.calib)
        m = D.train(df, cols)
        yt, yp = test["label"].to_numpy(), D.predict(m, test)
        classes = sorted(set(df["label"]) | set(test["label"]))
        ev = {"classes": classes, "confusion": D.confusion(yt, yp, classes),
              "folds": [("test", float(np.mean(yp == yt)), len(yt))],
              "mean": float(np.mean(yp == yt)), "std": 0.0}
        print("\neval: held-out test sessions", [p.split("/")[-1] for p in args.test])
    else:
        group, name = D.choose_grouping(df)
        print(f"\neval: {name}")
        ev = D.evaluate(df, cols, group)
        for g, acc, n in ev["folds"]:
            print(f"  fold {g}:  {acc*100:5.1f}%  (n={n})")

    print("\n" + D.report_text(ev, D.active_learning_hint(ev["confusion"], ev["classes"])))

    if args.save_model:
        m = D.train(df, cols)
        D.save_model(m, args.save_model)
        print(f"\nsaved model -> {args.save_model}  (classes {m['classes']})")


if __name__ == "__main__":
    main()
