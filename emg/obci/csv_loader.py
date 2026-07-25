"""Load recordings from disk.

Supports:
  1. This toolkit's own CSV/Parquet  (columns: timestamp_s, ch_1, ch_2, ...)
  2. OpenBCI GUI raw .txt exports     (header lines start with '%', columns
     named "EXG Channel 0..7", plus a "Timestamp" column)

This is the FALLBACK path: if live BrainFlow streaming is unavailable, record
in the OpenBCI GUI, then point analyze.py / the MCP tools at the .txt file.
"""
from __future__ import annotations

import json
import re
from pathlib import Path

import numpy as np

from . import config
from .recording import Recording


def load_recording(path, fs: float | None = None, board: str = "cyton") -> Recording:
    path = Path(path)
    if not path.exists():
        raise FileNotFoundError(f"Recording not found: {path}")
    if path.suffix.lower() == ".parquet":
        return _load_table(path, fs, board)
    with open(path, "r", errors="ignore") as f:
        head = f.read(500)
    if "%OpenBCI" in head or "EXG Channel" in head or "Sample Index" in head:
        return load_openbci_gui_txt(path, fs=fs, board=board)
    return _load_table(path, fs, board)


def _load_table(path: Path, fs, board) -> Recording:
    import pandas as pd

    if path.suffix.lower() == ".parquet":
        df = pd.read_parquet(path)
    else:
        df = pd.read_csv(path)
    df.columns = [str(c).strip() for c in df.columns]

    meta = {}
    meta_path = Path(str(path) + ".meta.json")
    if meta_path.exists():
        meta = json.loads(meta_path.read_text())

    fs = fs or meta.get("fs") or config.BOARD_SAMPLING_RATE.get(board, 250)
    ch_cols = [c for c in df.columns if re.fullmatch(r"ch_?\d+", c, flags=re.I)]
    if not ch_cols:
        raise ValueError(
            f"No channel columns (ch_1, ch_2, ...) in {path}; columns={list(df.columns)}"
        )
    channels = {int(re.findall(r"\d+", c)[0]): df[c].to_numpy(dtype=float) for c in ch_cols}
    ts_col = next((c for c in df.columns if "time" in c.lower()), None)
    ts = df[ts_col].to_numpy(dtype=float) if ts_col else np.arange(len(df)) / fs
    return Recording(
        fs=float(fs), timestamps=ts, channels=channels,
        label=meta.get("label", path.stem),
        source=meta.get("source", "file"), board=meta.get("board", board),
    )


def load_openbci_gui_txt(path, fs: float | None = None, board: str = "cyton") -> Recording:
    import pandas as pd

    path = Path(path)
    sample_rate = None
    with open(path, "r", errors="ignore") as f:
        for line in f:
            if not line.startswith("%"):
                break
            m = re.search(r"Sample Rate\s*=\s*([\d.]+)", line)
            if m:
                sample_rate = float(m.group(1))

    df = pd.read_csv(path, comment="%", skipinitialspace=True)
    df.columns = [str(c).strip() for c in df.columns]

    exg_cols = [c for c in df.columns if re.search(r"EXG Channel|^Channel\b", c, flags=re.I)]
    if not exg_cols:
        raise ValueError(
            f"No EXG channel columns found in {path}; columns={list(df.columns)}"
        )
    channels = {i + 1: df[c].to_numpy(dtype=float) for i, c in enumerate(exg_cols)}

    ts_col = next((c for c in df.columns if c.lower() == "timestamp"), None)
    if ts_col is None:
        ts_col = next(
            (c for c in df.columns
             if "timestamp" in c.lower() and "format" not in c.lower()),
            None,
        )
    fs = fs or sample_rate or config.BOARD_SAMPLING_RATE.get(board, 250)
    ts = df[ts_col].to_numpy(dtype=float) if ts_col else np.arange(len(df)) / fs
    return Recording(
        fs=float(fs), timestamps=ts, channels=channels,
        label=path.stem, source="openbci_gui", board=board,
    )
