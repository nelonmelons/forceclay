"""Live signal-quality monitor for one channel — watch the 60 Hz hum in real time
while you re-seat electrodes, before a recording session.

LIVE (needs the Cyton streaming, GUI closed):
    python live_monitor.py --channel 1

REPLAY a past recording through the same display (no hardware, for testing/demo):
    python live_monitor.py --replay ~/Documents/.../OpenBCI-RAW-....txt --speed 20

Each refresh shows, for the trailing window:
    raw RMS | EMG RMS (20-100 Hz, 60 Hz notched) | 60 Hz power + % of signal | verdict
Goal: get "60 Hz" into the CLEAN zone (ratio < 20%) and ideally near your best
past resting value (~140 uV^2) before you record.
"""
from __future__ import annotations

import argparse
import sys
import time

import numpy as np

import sys as _sys, pathlib as _pathlib
_sys.path.insert(0, str(_pathlib.Path(__file__).resolve().parent.parent))  # emg/ -> obci

from obci import config
from obci import signal_processing as sp

# Resting electrode quality is judged primarily by ABSOLUTE 60 Hz power (uV^2),
# NOT the ratio: at rest there's little EMG, so even tiny hum is a big fraction
# (this is why take 1 — a clean recording — looked "hummy" by ratio at rest).
GOOD_HUM_UV2 = 350.0     # at/below this = clean resting electrodes (take 1 was ~140-230)
OK_HUM_UV2 = 1000.0
HUM_BAR_FULL = 2000.0    # bar fills toward this "bad" ceiling, so you watch it shrink


def compute_readout(x, fs, trim: int = 0) -> dict:
    """`trim` drops that many samples off each end of the FILTERED signal.

    filtfilt rings at the window boundaries, and because a scrolling buffer is
    re-filtered from scratch every frame the ringing is pinned to the ends and never
    scrolls out. Left in, it dominated emg_rms by ~50x over the true baseline and
    pinned `burst` True at rest. Callers should pass a window `trim` samples longer
    on each side than the span they actually want measured.
    """
    x = np.asarray(x, dtype=float)
    raw_rms = sp.rms(x - np.mean(x))
    pre = sp.preprocess_emg(x, fs)                       # 60 Hz notched out
    if trim and pre.size > 4 * trim:
        pre = pre[trim:-trim]
    emg_rms = sp.rms(pre)                                # window-average (slow)
    # PEAK of the short moving-RMS envelope: catches brief/light bursts that the
    # window-average buries — this is what your eye sees as a "spike" on the graph.
    emg_peak = float(np.max(sp.emg_envelope(pre, fs))) if x.size else 0.0
    hum_uv2 = sp.bandpower(x, fs, (58, 62))["power_uv2"]  # absolute hum (raw)
    ratio = sp.line_noise_ratio(x, fs)
    rail_frac = float(np.mean(np.abs(x) > 0.9 * config.FULL_SCALE_UV))
    return {"raw_rms": raw_rms, "emg_rms": emg_rms, "emg_peak": emg_peak,
            "hum_uv2": hum_uv2 or 0.0, "ratio": ratio, "rail_frac": rail_frac}


# Envelope-peak (uV) above which we call it a contraction. Resting peak is ~4-6 uV,
# so this catches even light clenches the window-average RMS would miss.
EMG_DETECT_UV = 8.0


def render(r, channel, elapsed) -> str:
    hum, ratio = r["hum_uv2"], r["ratio"]
    peak = r.get("emg_peak", 0.0)
    emg_active = peak >= EMG_DETECT_UV
    if r["rail_frac"] > config.RAIL_FRACTION_THRESHOLD:
        verdict = "CLIPPING ⚠️  electrode off/loose?"
    elif emg_active:
        # During a contraction, muscle energy spills into the 60 Hz band — that's
        # not mains hum, so suppress the hum warning and flag the burst instead.
        verdict = f"● EMG burst  peak {peak:5.0f} uV"
    elif hum <= GOOD_HUM_UV2:
        verdict = "CLEAN ✅"
    elif hum <= OK_HUM_UV2:
        verdict = "ok ~   nudge BIAS/skin"
    else:
        verdict = "HUM ⚠️  fix BIAS / unplug charger"
    pct = int(min(1.0, hum / HUM_BAR_FULL) * 20)        # bar tracks absolute hum
    bar = "█" * pct + "·" * (20 - pct)
    rtxt = "--" if ratio is None else f"{ratio*100:3.0f}%"
    return (f"[{elapsed:6.1f}s] Ch{channel}  raw {r['raw_rms']:7.1f}  "
            f"EMG {r['emg_rms']:5.1f} (pk {peak:5.0f}) uV  |  60Hz {hum:7.1f} [{bar}] ({rtxt})  |  {verdict}")


def _emit(line, log):
    if log:
        print(line, flush=True)
    else:
        print("\r" + line + " " * 4, end="", flush=True)


def replay(path, channel, fs_override, window, interval, speed, log):
    from obci.csv_loader import load_recording
    rec = load_recording(path, fs=fs_override)
    fs = rec.fs
    x = rec.channel(channel)
    print(f"REPLAY {path}\n  fs={fs:g} Hz  dur={rec.duration_s:.0f}s  window={window}s  (speed x{speed})")
    print(f"  target: 60Hz power <= {GOOD_HUM_UV2:.0f} uV^2 = CLEAN, > {OK_HUM_UV2:.0f} = HUM\n")
    w = int(window * fs)
    step = int(interval * fs)
    for end in range(w, len(x) + 1, step):
        seg = x[end - w:end]
        _emit(render(compute_readout(seg, fs), channel, end / fs), log)
        if speed > 0:
            time.sleep(interval / speed)
    print("\n(replay done)")


def live(port, board, channel, window, interval, log, max_seconds=None):
    from obci.bridge import BridgeError, CytonBridge
    b = CytonBridge(port, board)
    try:
        b.start_stream()
    except BridgeError as e:
        print("ERROR:", e)
        return 1
    fs = b.sampling_rate
    print(f"LIVE on {b.serial_port} @ {fs} Hz, Ch{channel}.  Re-seat electrodes and watch 60Hz drop.")
    cap = f"running {max_seconds:g}s" if max_seconds else "Ctrl-C to stop"
    print(f"  target: 60Hz power <= {GOOD_HUM_UV2:.0f} uV^2 = CLEAN, > {OK_HUM_UV2:.0f} = HUM.  {cap}.\n")
    t0 = time.time()
    try:
        time.sleep(window)                       # let the buffer fill one window
        while True:
            rec = b.get_recent(window)
            x = rec.channel(channel)
            if x.size >= int(0.5 * window * fs):
                _emit(render(compute_readout(x, fs), channel, time.time() - t0), log)
            if max_seconds and (time.time() - t0) >= max_seconds:
                break
            time.sleep(interval)
    except KeyboardInterrupt:
        print("\nstopping…")
    finally:
        b.release()
    return 0


def main() -> int:
    ap = argparse.ArgumentParser(description="Live single-channel quality / 60 Hz monitor")
    ap.add_argument("--channel", type=int, default=1)
    ap.add_argument("--window", type=float, default=2.0, help="trailing analysis window (s)")
    ap.add_argument("--interval", type=float, default=0.5, help="refresh interval (s)")
    ap.add_argument("--log", action="store_true", help="print a new line each refresh (vs in-place)")
    ap.add_argument("--replay", metavar="FILE", help="replay a recording instead of going live")
    ap.add_argument("--speed", type=float, default=10.0, help="replay speed multiplier")
    ap.add_argument("--seconds", type=float, default=None, help="auto-stop live run after N seconds")
    ap.add_argument("--fs", type=float, default=None, help="override sampling rate (replay)")
    ap.add_argument("--port", default=config.DEFAULT_SERIAL_PORT)
    ap.add_argument("--board", default=config.DEFAULT_BOARD, choices=["cyton", "cyton_daisy"])
    args = ap.parse_args()
    if args.replay:
        replay(args.replay, args.channel, args.fs, args.window, args.interval, args.speed, args.log)
        return 0
    return live(args.port, args.board, args.channel, args.window, args.interval, args.log, args.seconds)


if __name__ == "__main__":
    sys.exit(main())
