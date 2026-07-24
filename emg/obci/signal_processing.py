"""EMG / general biosignal processing.

Pure numpy/scipy — no hardware dependency, so every function here is unit-test
friendly and works identically on live BrainFlow data or imported CSV files.

Conventions:
  * All amplitudes are in microvolts (uV). BrainFlow returns Cyton EXG data in uV.
  * `fs` is the sampling rate in Hz (250 for Cyton 8-ch, 125 for Daisy 16-ch).
  * RMS / MAV / waveform-length / zero-crossings are computed on the 20-100 Hz
    EMG-bandpassed signal (standard surface-EMG amplitude estimate).
  * Band POWER is computed on the notch-filtered but otherwise broadband signal
    (so a band like 80-120 Hz is not attenuated by the EMG bandpass).
"""
from __future__ import annotations

import numpy as np
from scipy.integrate import trapezoid
from scipy.signal import butter, detrend, filtfilt, iirnotch, welch

from . import config


# --- filters ----------------------------------------------------------------
def notch_filter(x, fs, freq=config.NOTCH_FREQ_HZ, q=config.NOTCH_Q):
    """Remove mains hum at `freq`. No-op if freq is at/above Nyquist."""
    x = np.asarray(x, dtype=float)
    if x.size < 9 or freq >= fs / 2.0:
        return x
    b, a = iirnotch(freq, q, fs=fs)
    # A high-Q notch rings for a long time, so filtfilt's ~9-sample default padding
    # leaves a visible edge transient. Pad by a quarter second like the band-pass.
    padlen = min(x.size - 1, max(3 * max(len(a), len(b)), int(0.25 * fs)))
    return filtfilt(b, a, x, padlen=padlen)


def bandpass_filter(x, fs, low, high, order=config.EMG_FILTER_ORDER):
    """Zero-phase Butterworth band-pass. `high` is clamped below Nyquist."""
    x = np.asarray(x, dtype=float)
    nyq = fs / 2.0
    high = min(float(high), nyq * 0.99)
    low = max(float(low), 0.1)
    if low >= high:
        raise ValueError(f"Invalid band {low}-{high} Hz for fs={fs} Hz")
    b, a = butter(order, [low / nyq, high / nyq], btype="band")
    min_pad = 3 * max(len(a), len(b))
    if x.size <= min_pad:                # too short for filtfilt; just DC-remove
        return x - np.mean(x)
    # Pad generously and explicitly. The old code computed a padlen and then never
    # passed it, so filtfilt fell back to its ~24-sample default -- far too short
    # for a 20 Hz high-pass to settle, which left a huge transient at both window
    # edges on every call.
    padlen = min(x.size - 1, max(min_pad, int(0.25 * fs)))
    return filtfilt(b, a, x, padlen=padlen)


def preprocess_emg(x, fs, band=None, notch=None):
    """Notch (+ first harmonic if it fits) then EMG band-pass. Reads config at
    call time (runtime-tunable) unless band/notch are passed explicitly.

    The input is detrended first. filtfilt extends the signal about its endpoints,
    so a large electrode DC offset or slow drift becomes a step at the boundary and
    rings for hundreds of samples -- which showed up as multi-millivolt "bursts" at
    the edge of every window while the true resting baseline was ~15-25 uV.
    """
    band = band if band is not None else config.EMG_BANDPASS_HZ
    notch = notch if notch is not None else config.NOTCH_FREQ_HZ
    x = np.asarray(x, dtype=float)
    if x.size >= 4:
        x = detrend(x, type="linear")
    y = notch_filter(x, fs, notch)
    if notch * 2 < fs / 2.0:
        y = notch_filter(y, fs, notch * 2)   # 120 Hz harmonic if below Nyquist
    return bandpass_filter(y, fs, band[0], band[1])


# --- time-domain EMG features ----------------------------------------------
def rms(x) -> float:
    x = np.asarray(x, dtype=float)
    return float(np.sqrt(np.mean(x ** 2))) if x.size else 0.0


def mean_absolute_value(x) -> float:
    x = np.asarray(x, dtype=float)
    return float(np.mean(np.abs(x))) if x.size else 0.0


def waveform_length(x) -> float:
    x = np.asarray(x, dtype=float)
    return float(np.sum(np.abs(np.diff(x)))) if x.size > 1 else 0.0


def zero_crossings(x, threshold: float = 0.0) -> int:
    """Count sign changes whose step exceeds `threshold` uV (noise dead-zone)."""
    x = np.asarray(x, dtype=float)
    if x.size < 2:
        return 0
    prod = x[:-1] * x[1:]
    step = np.abs(x[:-1] - x[1:])
    return int(np.sum((prod < 0) & (step > threshold)))


# --- frequency-domain -------------------------------------------------------
def _psd(x, fs, nperseg=None):
    x = np.asarray(x, dtype=float)
    if x.size < 16:
        return np.array([0.0]), np.array([0.0])
    if nperseg is None:
        nperseg = int(min(x.size, max(64, fs)))   # ~1 s windows
    nperseg = int(max(16, min(nperseg, x.size)))
    f, pxx = welch(x, fs=fs, nperseg=nperseg)
    return f, pxx


def bandpower(x, fs, band, nperseg=None) -> dict:
    """Integrated PSD over [low, high] Hz, with explicit Nyquist guarding."""
    low, high = float(band[0]), float(band[1])
    nyq = fs / 2.0
    out = {"band_hz": [low, high], "power_uv2": None, "valid": True, "warning": None}
    if low >= nyq:
        out.update(
            valid=False,
            warning=f"band starts at {low} Hz >= Nyquist {nyq} Hz; not measurable at fs={fs} Hz",
        )
        return out
    if high > nyq:
        out["warning"] = f"band top {high} Hz exceeds Nyquist {nyq} Hz; clamped to {nyq} Hz"
        high = nyq
    f, pxx = _psd(x, fs, nperseg)
    idx = (f >= low) & (f <= high)
    out["power_uv2"] = float(trapezoid(pxx[idx], f[idx])) if np.any(idx) else 0.0
    out["band_hz"] = [low, high]
    return out


def total_power(x, fs) -> float:
    f, pxx = _psd(x, fs)
    return float(trapezoid(pxx, f))


def line_noise_ratio(x, fs, line=config.NOTCH_FREQ_HZ, halfwidth=2.0):
    """Fraction of total power within +/- halfwidth of the mains frequency.

    Computes the PSD once (was 2 Welch transforms: bandpower + total_power).
    """
    if line + halfwidth >= fs / 2.0:
        return None
    f, pxx = _psd(x, fs)
    tot = float(trapezoid(pxx, f))
    if not tot:
        return None
    idx = (f >= line - halfwidth) & (f <= line + halfwidth)
    bp = float(trapezoid(pxx[idx], f[idx])) if np.any(idx) else 0.0
    return float(bp / tot)


# --- envelope + spike detection --------------------------------------------
def emg_envelope(x, fs, win_s: float = 0.15):
    """Moving-RMS envelope (window in seconds)."""
    x = np.asarray(x, dtype=float)
    w = max(1, int(win_s * fs))
    kernel = np.ones(w) / w
    return np.sqrt(np.convolve(x ** 2, kernel, mode="same"))


def _runs_above(mask, fs, min_len_samples):
    events, i, n = [], 0, len(mask)
    while i < n:
        if mask[i]:
            j = i
            while j < n and mask[j]:
                j += 1
            if (j - i) >= min_len_samples:
                events.append((i, j))
            i = j
        else:
            i += 1
    return events


def detect_emg_spike(raw, fs, band=config.EMG_BANDPASS_HZ,
                     win_s: float = 0.15, k: float = 4.0,
                     min_dur_s: float = 0.05) -> dict:
    """Detect EMG bursts via a robust envelope threshold (baseline + k*MAD)."""
    emg = preprocess_emg(raw, fs, band)
    env = emg_envelope(emg, fs, win_s)
    # Estimate the resting baseline from the QUIET half of the envelope, so a
    # window containing rest -> burst still detects the burst (a median baseline
    # fails when most of the window is active).
    lower = env[env <= np.median(env)] if env.size else env
    baseline = float(np.median(lower)) if lower.size else 0.0
    sigma = float(np.std(lower)) + 1e-9
    thresh = baseline + k * sigma
    runs = _runs_above(env > thresh, fs, int(min_dur_s * fs))
    events = [
        {
            "start_s": round(i / fs, 3),
            "end_s": round(j / fs, 3),
            "duration_s": round((j - i) / fs, 3),
            "peak_rms_uv": round(float(np.max(env[i:j])), 2),
            "mean_rms_uv": round(float(np.mean(env[i:j])), 2),
        }
        for (i, j) in runs
    ]
    return {
        "spike_detected": len(events) > 0,
        "n_events": len(events),
        "baseline_rms_uv": round(baseline, 2),
        "threshold_uv": round(thresh, 2),
        "envelope_peak_uv": round(float(np.max(env)) if env.size else 0.0, 2),
        "events": events,
    }


# --- artifact (cable-tug / motion) detection --------------------------------
def detect_artifacts(raw, fs, k: float = 6.0) -> dict:
    """Flag sudden large LOW-frequency transients (cable tug, motion).

    Motion/cable artifacts live mostly below ~10 Hz and are large; EMG lives at
    20-150 Hz. We isolate 0.5-10 Hz, build an envelope, and flag robust spikes.
    """
    notched = notch_filter(raw, fs)
    low = bandpass_filter(notched, fs, 0.5, min(10.0, fs / 2.0 * 0.9))
    env = emg_envelope(low, fs, win_s=0.1)
    med = float(np.median(env))
    mad = float(np.median(np.abs(env - med))) + 1e-9
    thresh = med + k * 1.4826 * mad
    runs = _runs_above(env > thresh, fs, int(0.02 * fs))
    events = [
        {"start_s": round(i / fs, 3), "end_s": round(j / fs, 3),
         "peak_uv": round(float(np.max(env[i:j])), 2)}
        for (i, j) in runs
    ]
    return {
        "artifact_detected": len(events) > 0,
        "n_artifacts": len(events),
        "threshold_uv": round(thresh, 2),
        "events": events[:20],
    }


# --- per-channel quality ----------------------------------------------------
def signal_quality(raw, fs) -> dict:
    """Classify a single channel: connected / floating / railing / flat."""
    raw = np.asarray(raw, dtype=float)
    if raw.size == 0:
        return {"classification": "empty", "flags": ["no samples"]}
    raw_rms = rms(raw - np.mean(raw))
    std = float(np.std(raw))
    pk2pk = float(np.ptp(raw))
    rail = config.FULL_SCALE_UV
    rail_frac = float(np.mean(np.abs(raw) > 0.9 * rail))
    line_ratio = line_noise_ratio(raw, fs)

    flags, classification = [], "looks_connected"
    if rail_frac > config.RAIL_FRACTION_THRESHOLD:
        classification = "railing_or_clipping"
        flags.append(f"{rail_frac * 100:.1f}% of samples near +/-{rail:.0f} uV full scale")
    elif std < config.FLAT_STD_UV:
        classification = "flat_or_dead"
        flags.append(f"std={std:.2f} uV — near-flat; channel may be off or shorted")
    elif line_ratio is not None and line_ratio > config.LINE_DOMINATED_RATIO:
        classification = "mains_dominated_floating"
        flags.append(
            f"{line_ratio * 100:.0f}% of power at {config.NOTCH_FREQ_HZ:.0f} Hz "
            f"— likely floating / poor electrode contact"
        )
    elif raw_rms > 5000:
        classification = "very_high_amplitude"
        flags.append(f"raw RMS {raw_rms:.0f} uV is very high for surface EMG")

    line_info = None
    if line_ratio is not None:
        line_info = {
            "line_noise_ratio": round(line_ratio, 3),
            "significant_60hz": line_ratio > config.LINE_SIGNIFICANT_RATIO,
        }
    return {
        "classification": classification,
        "raw_rms_uv": round(raw_rms, 2),
        "std_uv": round(std, 2),
        "peak_to_peak_uv": round(pk2pk, 2),
        "rail_fraction": round(rail_frac, 5),
        "full_scale_uv": round(rail, 1),
        "clipping": rail_frac > config.RAIL_FRACTION_THRESHOLD,
        "floating_or_noisy": classification in (
            "mains_dominated_floating", "railing_or_clipping", "very_high_amplitude",
        ),
        "line_noise": line_info,
        "flags": flags,
    }


# --- full EMG feature set ---------------------------------------------------
def emg_features(raw, fs, bands=None, band=config.EMG_BANDPASS_HZ) -> dict:
    raw = np.asarray(raw, dtype=float)
    bands = bands or config.DEFAULT_EMG_BANDS
    notched = notch_filter(raw, fs)
    if config.NOTCH_FREQ_HZ * 2 < fs / 2.0:
        notched = notch_filter(notched, fs, config.NOTCH_FREQ_HZ * 2)
    emg = bandpass_filter(notched, fs, band[0], band[1])
    dur = raw.size / fs if fs else 0.0
    zc = zero_crossings(emg, threshold=0.0)
    return {
        "n_samples": int(raw.size),
        "duration_s": round(dur, 3),
        "fs_hz": fs,
        "nyquist_hz": fs / 2.0,
        "emg_band_hz": list(band),
        "rms_uv": round(rms(emg), 3),
        "mav_uv": round(mean_absolute_value(emg), 3),
        "waveform_length_uv": round(waveform_length(emg), 1),
        "zero_crossings": zc,
        "zc_rate_hz": round(zc / dur, 1) if dur else 0.0,
        "bandpowers": {name: bandpower(notched, fs, b) for name, b in bands.items()},
        "line_noise_ratio_raw": (
            round(line_noise_ratio(raw, fs), 3)
            if line_noise_ratio(raw, fs) is not None else None
        ),
    }


# --- rest vs clench comparison ---------------------------------------------
def compare_rest_vs_clench(rest, clench, channel: int = 1, bands=None) -> dict:
    """`rest` and `clench` are Recording objects. Returns features + verdict."""
    bands = bands or config.DEFAULT_EMG_BANDS
    fs = rest.fs
    r = emg_features(rest.channel(channel), fs, bands)
    c = emg_features(clench.channel(channel), fs, bands)

    def ratio(a, b):
        return round(float(b / a), 2) if a else None

    rms_ratio = ratio(r["rms_uv"], c["rms_uv"])
    band_ratios = {}
    for name in bands:
        ra = r["bandpowers"][name]["power_uv2"]
        ca = c["bandpowers"][name]["power_uv2"]
        band_ratios[name] = ratio(ra, ca) if (ra and ca is not None) else None

    clench_line = c["line_noise_ratio_raw"]
    mid = band_ratios.get("emg_mid_40_80")
    likely_emg = bool(
        rms_ratio is not None and rms_ratio >= 3.0
        and mid is not None and mid >= 2.0
        and (clench_line is None or clench_line < config.LINE_DOMINATED_RATIO)
    )

    notes = []
    if rms_ratio is not None:
        notes.append(
            f"EMG RMS rose {rms_ratio:.1f}x rest->clench"
            if rms_ratio >= 3 else
            f"EMG RMS only rose {rms_ratio:.1f}x — weak or no contraction signal"
        )
    if clench_line is not None and clench_line >= config.LINE_DOMINATED_RATIO:
        notes.append("clench power dominated by 60 Hz — suspect mains interference, not muscle")
    for name, rr in band_ratios.items():
        if rr is None and c["bandpowers"][name]["warning"]:
            notes.append(f"{name}: {c['bandpowers'][name]['warning']}")

    return {
        "channel": channel,
        "fs_hz": fs,
        "rms_ratio_clench_over_rest": rms_ratio,
        "bandpower_ratios_clench_over_rest": band_ratios,
        "likely_valid_emg": likely_emg,
        "notes": notes,
        "rest": r,
        "clench": c,
    }
