"""Recording: an in-memory chunk of multi-channel data + persistence.

Canonical on-disk format (written by this toolkit):
  <name>.csv         columns: timestamp_s, ch_1, ch_2, ... (microvolts)
  <name>.csv.meta.json   {fs, board, label, source, channels, n_samples, created_at}

Parquet uses the same columns + sidecar. Either can be read back by
obci.csv_loader.load_recording(), which also reads OpenBCI GUI .txt exports.
"""
from __future__ import annotations

import json
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path

import numpy as np


@dataclass
class Recording:
    fs: float                       # sampling rate (Hz)
    timestamps: np.ndarray          # 1-D, seconds (epoch or relative)
    channels: dict                  # {1-based channel int -> np.ndarray microvolts}
    label: str = ""
    source: str = ""                # "brainflow" | "openbci_gui" | "file"
    board: str = "cyton"

    @property
    def n_samples(self) -> int:
        return int(len(self.timestamps))

    @property
    def duration_s(self) -> float:
        return self.n_samples / self.fs if self.fs else 0.0

    def channel(self, ch: int) -> np.ndarray:
        if ch not in self.channels:
            raise KeyError(
                f"Channel {ch} not in recording (available: {sorted(self.channels)})"
            )
        return np.asarray(self.channels[ch], dtype=float)

    # --- persistence --------------------------------------------------------
    def _dataframe(self):
        import pandas as pd

        cols = {"timestamp_s": np.asarray(self.timestamps, dtype=float)}
        for ch in sorted(self.channels):
            cols[f"ch_{ch}"] = np.asarray(self.channels[ch], dtype=float)
        return pd.DataFrame(cols)

    def _write_meta(self, path: Path) -> None:
        meta = {
            "fs": self.fs,
            "board": self.board,
            "label": self.label,
            "source": self.source,
            "channels": sorted(self.channels),
            "n_samples": self.n_samples,
            "duration_s": self.duration_s,
            "created_at": datetime.now(timezone.utc).isoformat(),
        }
        Path(str(path) + ".meta.json").write_text(json.dumps(meta, indent=2))

    def save(self, path) -> Path:
        path = Path(path)
        path.parent.mkdir(parents=True, exist_ok=True)
        df = self._dataframe()
        if path.suffix.lower() == ".parquet":
            df.to_parquet(path, index=False)
        else:
            df.to_csv(path, index=False)
        self._write_meta(path)
        return path
