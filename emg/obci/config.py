"""Central configuration + hardware constants.

Everything here can be overridden with environment variables so the same code
works for your Cyton dongle today and a Daisy/16-channel board later.
"""
from __future__ import annotations

import os
from pathlib import Path

# --- Serial / board ---------------------------------------------------------
# Your OpenBCI dongle was auto-detected at this port. Override with
#   export OPENBCI_SERIAL_PORT=/dev/cu.usbserial-XXXX
DEFAULT_SERIAL_PORT = os.environ.get(
    "OPENBCI_SERIAL_PORT", "/dev/cu.usbserial-DP04WG7Q"
)

# "cyton"        -> 8 channels, treated as 250 Hz
# "cyton_daisy"  -> 16 channels, treated as 125 Hz
DEFAULT_BOARD = os.environ.get("OPENBCI_BOARD", "cyton").lower()
BOARD_SAMPLING_RATE = {"cyton": 250, "cyton_daisy": 125}

# Where recordings + their .meta.json sidecars are written.
DATA_DIR = Path(
    os.environ.get(
        "OPENBCI_DATA_DIR", Path(__file__).resolve().parent.parent / "recordings"
    )
)
DATA_DIR.mkdir(parents=True, exist_ok=True)

# --- Cyton front-end scaling (ADS1299) --------------------------------------
# BrainFlow already returns EXG channels in MICROVOLTS, but we need the
# full-scale value to detect railing / clipping on a floating electrode.
ADC_VREF_V = 4.5                       # ADS1299 reference voltage
DEFAULT_GAIN = 24                      # OpenBCI Cyton default PGA gain
ADC_FULL_SCALE_COUNTS = (2 ** 23) - 1  # 24-bit signed
UV_PER_COUNT = (ADC_VREF_V / DEFAULT_GAIN / ADC_FULL_SCALE_COUNTS) * 1e6
FULL_SCALE_UV = ADC_FULL_SCALE_COUNTS * UV_PER_COUNT  # ~187,500 uV

# --- DSP defaults -----------------------------------------------------------
NOTCH_FREQ_HZ = 60.0          # US mains hum
NOTCH_Q = 30.0
# Tuned 2026-06-20: 20-120 Hz (was 20-100) captures EMG we were discarding below
# Nyquist; with a 300 ms window this lifted LOSO 90.3%->93.5%, variance 10.9->8.8.
EMG_BANDPASS_HZ = (20.0, 120.0)
EMG_FILTER_ORDER = 4

# Feature windowing (single source of truth for train + live inference)
EMG_WINDOW_S = 0.30
EMG_HOP_S = 0.05

# EMG analysis bands (Hz). 80-120 is only valid at 250 Hz sampling
# (Nyquist 125 Hz); at 125 Hz sampling it is flagged as above-Nyquist.
DEFAULT_EMG_BANDS = {
    "emg_low_20_40": (20.0, 40.0),
    "emg_mid_40_80": (40.0, 80.0),
    "emg_high_80_120": (80.0, 120.0),
}

# Quality-classification thresholds (tunable; documented in README).
RAIL_FRACTION_THRESHOLD = 0.005   # >0.5% of samples near full scale => clipping
FLAT_STD_UV = 1.0                 # std below this => flat/dead channel
LINE_DOMINATED_RATIO = 0.5        # >50% of power at 60 Hz => floating/poor contact
LINE_SIGNIFICANT_RATIO = 0.2      # >20% of power at 60 Hz => notable hum
