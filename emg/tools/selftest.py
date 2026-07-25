"""Hardware-free self-test. Synthesizes rest / clench / mixed EMG and exercises
the whole DSP pipeline. Run this right after install to confirm the toolkit
works before you touch the board:

    python selftest.py
"""
from __future__ import annotations

import numpy as np

import sys as _sys, pathlib as _pathlib
_sys.path.insert(0, str(_pathlib.Path(__file__).resolve().parent.parent))  # emg/ -> obci

from obci import signal_processing as sp
from obci.recording import Recording


def synth_emg(fs, secs, emg_uv, line_uv=8.0, noise_uv=2.0, seed=0):
    """Surface-EMG-like signal: 20-100 Hz band-limited noise + 60 Hz hum + baseline."""
    rng = np.random.default_rng(seed)
    n = int(fs * secs)
    t = np.arange(n) / fs
    emg = sp.bandpass_filter(rng.standard_normal(n), fs, 20, 100)
    emg = emg / (sp.rms(emg) + 1e-9) * emg_uv
    hum = line_uv * np.sin(2 * np.pi * 60 * t)
    baseline = rng.standard_normal(n) * noise_uv
    return t, emg + hum + baseline


def rec(fs, channels):
    n = len(next(iter(channels.values())))
    return Recording(fs=fs, timestamps=np.arange(n) / fs, channels=channels, label="synth")


def main() -> int:
    fs = 250

    # pure rest (10s) and pure clench (2s) for the rest-vs-clench comparison
    floating = 60.0 * np.sin(2 * np.pi * 60 * np.arange(10 * fs) / fs)  # mains-only ch2
    rest = rec(fs, {1: synth_emg(fs, 10, emg_uv=4.0, seed=1)[1], 2: floating})
    clench = rec(fs, {1: synth_emg(fs, 2, emg_uv=80.0, seed=2)[1]})

    cmp = sp.compare_rest_vs_clench(rest, clench, channel=1)
    print(f"rest  EMG RMS : {cmp['rest']['rms_uv']:.1f} uV")
    print(f"clench EMG RMS: {cmp['clench']['rms_uv']:.1f} uV")
    print(f"RMS ratio     : {cmp['rms_ratio_clench_over_rest']}x")
    print(f"band ratios   : {cmp['bandpower_ratios_clench_over_rest']}")
    print(f"likely EMG    : {cmp['likely_valid_emg']}")

    # mixed window rest(1s)+clench(2s)+rest(1s) for spike detection
    parts = [synth_emg(fs, 1, 4, seed=3)[1], synth_emg(fs, 2, 80, seed=4)[1], synth_emg(fs, 1, 4, seed=5)[1]]
    mixed = np.concatenate(parts)
    spike = sp.detect_emg_spike(mixed, fs)
    print(f"\nspike detected: {spike['spike_detected']}  events={spike['n_events']}  "
          f"baseline={spike['baseline_rms_uv']} thresh={spike['threshold_uv']}")

    q1 = sp.signal_quality(rest.channel(1), fs)
    q2 = sp.signal_quality(rest.channel(2), fs)
    print(f"ch1 quality   : {q1['classification']} (RMS {q1['raw_rms_uv']} uV)")
    print(f"ch2 quality   : {q2['classification']} (floating mains test)")

    bp = sp.bandpower(clench.channel(1), 125, (80, 120))   # Nyquist guard @125 Hz
    print(f"\n80-120 Hz @125 Hz sampling -> valid={bp['valid']} warning={bp['warning']!r}")

    assert cmp["rms_ratio_clench_over_rest"] > 3, "clench should be >>3x rest"
    assert cmp["likely_valid_emg"] is True
    assert spike["spike_detected"], "burst in mixed window should be detected"
    assert q2["classification"] == "mains_dominated_floating", "ch2 should read as floating"
    assert bp["valid"] is False, "80-120 Hz must be flagged above Nyquist at 125 Hz"
    print("\nSELFTEST PASSED ✅")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
