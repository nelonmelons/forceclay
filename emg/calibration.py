"""Per-session rest/max calibration for the EMG pipeline.

Maps a raw envelope value (RMS+EMA smoothed) into 0..1 using a linear
scale between a collected rest baseline and a collected max-clench
ceiling. Never hardcode thresholds -- everything derives from these two
collected reference points.
"""

from __future__ import annotations

import statistics
from typing import List, Optional


class ChannelCalibration:
    """Rest/max calibration for a single scalar signal (one channel or an aggregate).

    @remarks Baseline/ceiling are set once per collection window (~3s of
    samples) rather than continuously, so normalization stays stable
    between calibration runs.
    """

    def __init__(self) -> None:
        self._rest: Optional[float] = None
        self._max: Optional[float] = None

    @property
    def calibrated(self) -> bool:
        """True once both rest and max have been set."""
        return self._rest is not None and self._max is not None

    def set_rest(self, samples: List[float]) -> None:
        """Finalize the rest baseline as the median of collected samples."""
        if samples:
            self._rest = statistics.median(samples)

    def set_max(self, samples: List[float]) -> None:
        """Finalize the max-clench ceiling as the 95th percentile of collected samples.

        @remarks A high percentile (rather than the raw max) guards against a
        single noise spike making the whole session's calibration degenerate.
        """
        if samples:
            ordered = sorted(samples)
            idx = min(len(ordered) - 1, int(0.95 * (len(ordered) - 1)))
            self._max = ordered[idx]

    def reset(self) -> None:
        """Clear rest and max; `calibrated` goes back to False."""
        self._rest = None
        self._max = None

    def normalize(self, raw: float) -> float:
        """Map `raw` into 0..1 using the calibrated rest..max range, clamped.

        Returns 0.0 if not yet calibrated, or if rest and max collapsed to
        the same value (degenerate range), to avoid a divide-by-zero.
        """
        if not self.calibrated:
            return 0.0
        span = self._max - self._rest
        if span <= 1e-9:
            return 0.0
        value = (raw - self._rest) / span
        return max(0.0, min(1.0, value))


class MultiChannelCalibration:
    """Holds one aggregate calibration (for `force`) plus N independent per-channel
    calibrations (for `perChannel`), all fed from the same rest/max collection windows.
    """

    def __init__(self, num_channels: int) -> None:
        self.num_channels = num_channels
        self.aggregate = ChannelCalibration()
        self.channels = [ChannelCalibration() for _ in range(num_channels)]

    @property
    def calibrated(self) -> bool:
        """True once the aggregate calibration is complete (drives EmgMessage.calibrated)."""
        return self.aggregate.calibrated

    def set_rest(self, aggregate_samples: List[float], channel_samples: List[List[float]]) -> None:
        """Finalize rest baselines for the aggregate and every channel."""
        self.aggregate.set_rest(aggregate_samples)
        for ch, samples in zip(self.channels, channel_samples):
            ch.set_rest(samples)

    def set_max(self, aggregate_samples: List[float], channel_samples: List[List[float]]) -> None:
        """Finalize max ceilings for the aggregate and every channel."""
        self.aggregate.set_max(aggregate_samples)
        for ch, samples in zip(self.channels, channel_samples):
            ch.set_max(samples)

    def reset(self) -> None:
        """Reset the aggregate and every channel's calibration."""
        self.aggregate.reset()
        for ch in self.channels:
            ch.reset()

    def normalize_force(self, raw_aggregate: float) -> float:
        """Normalize the aggregate/primary signal into `force` (0..1)."""
        return self.aggregate.normalize(raw_aggregate)

    def normalize_channels(self, raw_channels: List[float]) -> List[float]:
        """Normalize each channel's raw envelope into `perChannel` (0..1 each)."""
        return [ch.normalize(v) for ch, v in zip(self.channels, raw_channels)]
