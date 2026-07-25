"""EMG backend (Task B) -- BrainFlow (or --mock) WebSocket server on :6970.

Contract (must match frontend/src/contracts.ts EmgMessage exactly):

  Server -> client, pushed at ~40Hz:
    {
      "force": 0.0..1.0,          # normalized clench, primary signal
      "perChannel": [0.0..1.0, ...],  # length 8 (mock) or len(--channels) on real board
      "calibrated": bool           # false until rest+max calibration has run this session
      # "mode" and "fatigue" are omitted entirely -- not implemented yet.
    }

  Client -> server (control messages, JSON):
    {"cmd": "calibrate_rest"} | {"cmd": "calibrate_max"} | {"cmd": "reset"}

Pipeline: BrainFlow (BoardIds.CYTON_BOARD @ 250 Hz by default, serial port) OR --mock
(synthetic force: slow sine + noise + occasional spikes, no hardware required) ->
cascaded SOS 60/120 Hz notch + 20-100 Hz band-pass, filter state CARRIED ACROSS
CHUNKS -> 100 ms moving RMS per channel -> EMA smoothing (alpha ~= 0.25) ->
LDA-weighted sum of log-envelopes -> normalize via per-session rest/max calibration
(calibration.py, ~1.2s collection windows) -> emit EmgMessage.

The filter state matters: filtering each ~3-6 sample chunk in isolation, as
DataFilter.perform_bandpass does, never lets a 4th-order Butterworth converge, so
the envelope is mostly filter transient. See RealEmgSource for the measurements
behind the board choice and the channel weighting.

Never hardcode force thresholds -- amplitude varies by person/placement/session;
always derive 0..1 from the calibrated rest/max range.

brainflow is imported lazily, only inside the real-board code path, so `--mock`
runs with just numpy + websockets installed.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import random
import time
from collections import deque
from math import pi, sin
from typing import List, Optional, Tuple

import numpy as np
import websockets

from calibration import MultiChannelCalibration

HOST = "localhost"
PORT = 6970
TICK_HZ = 40
TICK_DT = 1.0 / TICK_HZ
CALIBRATION_WINDOW_S = 1.2
MOCK_NUM_CHANNELS = 8

# Response shaping, applied to `force` AFTER calibration maps it to 0..1.
#
# The board axis is a weighted sum of LOG envelopes, because that is the space the
# LDA weights were fitted in. A log compresses the top of the range and expands the
# bottom, so light contractions read far hotter than their amplitude warrants: at
# rest 4.6 uV and clench 56.6 uV, a light 12 uV squeeze lands at 38% on the log axis
# but only 14% of the linear amplitude span. Squaring the normalized value undoes
# almost exactly that much, so GAMMA=2.0 restores a roughly linear-in-amplitude feel
# while leaving both endpoints (0 and 1) fixed. Raise it for a stiffer grip.
#
# DEADZONE then lifts the floor so resting jitter and an open/pointing hand -- the
# extensors fire on extension too -- do not register as a light grip.
DEFAULT_GAMMA = 2.0
DEFAULT_DEADZONE = 0.08


def shape_force(x: float, gamma: float = DEFAULT_GAMMA,
                deadzone: float = DEFAULT_DEADZONE) -> float:
    """Map a calibrated 0..1 force through deadzone + gamma, endpoints preserved."""
    if deadzone > 0.0:
        x = (x - deadzone) / (1.0 - deadzone)
    x = max(0.0, min(1.0, x))
    return x ** gamma if gamma != 1.0 else x


class MockEmgSource:
    """Synthetic EMG envelope generator: slow sine + noise + occasional clench-like spikes.

    Feeds the exact same raw-value shape a real channel envelope would (arbitrary
    positive units), so it can be normalized by the same calibration.py used by
    the real pipeline.
    """

    def __init__(self, num_channels: int = MOCK_NUM_CHANNELS) -> None:
        self.num_channels = num_channels
        self._t = 0.0
        self._spike_until = 0.0
        self._next_spike_at = random.uniform(2.0, 5.0)

    def sample(self, boost: bool = False) -> Tuple[float, List[float]]:
        """Return (raw_aggregate, raw_per_channel) for the next tick.

        `boost` requests a temporarily elevated/spiky segment (used during
        max-clench calibration windows so the ceiling isn't just noise).
        """
        self._t += TICK_DT
        base = 0.5 + 0.5 * sin(2 * pi * 0.15 * self._t)
        noise = random.gauss(0.0, 0.05)

        # Spontaneous clench-like spikes every few seconds.
        if self._t >= self._next_spike_at and self._t >= self._spike_until:
            self._spike_until = self._t + random.uniform(0.3, 0.8)
            self._next_spike_at = self._t + random.uniform(3.0, 7.0)
        spike = random.uniform(1.5, 3.0) if self._t < self._spike_until else 0.0

        if boost and random.random() < 0.6:
            spike = max(spike, random.uniform(2.0, 3.5))

        aggregate = max(0.0, base + noise + spike)
        channels = [max(0.0, aggregate + random.gauss(0.0, 0.08)) for _ in range(self.num_channels)]
        return aggregate, channels


class RealEmgSource:
    """Cyton envelope source, built on obci.bridge + a stateful causal SOS filter.

    Backed by the same `obci` package the calibration and recording tools in
    emg/tools/ use, so there is exactly one board-handling and one DSP
    implementation rather than two that can drift apart.

    Four things this gets right that a bare BrainFlow loop does not, each measured
    on a 60 s labelled session (rest / clench / point, left forearm, bipolar pairs):

    1. BIPOLAR CHANNEL CONFIG. The Cyton firmware boots with SRB2 ON, which
       references every channel to the shared SRB2 rail. On a bipolar montage
       (two electrodes per channel into one Nxp column) that rail is unwired and
       floating, and every connected channel reads ~100% 60 Hz hum. CytonBridge
       .configure_channels() sends the per-channel `x..` commands that switch to
       true INxP-vs-INxN and power down unused channels so their electrodes stay
       out of the BIAS loop. Skipping this step is the difference between signal
       and mains.

    2. STATEFUL CAUSAL FILTER. One cascaded SOS (60/120 Hz notch + band-pass)
       carries its `zi` state across chunks. Filtering each get_board_data() chunk
       in isolation -- which is what DataFilter.perform_bandpass does -- means a
       4th-order Butterworth over the ~3-6 samples a 40 Hz tick delivers, i.e.
       essentially all startup transient and no convergence. Zero added latency,
       and phase distortion is irrelevant under an RMS envelope.

    3. WEIGHTED AXIS, NOT A MEAN. mean(channels) lets the worst electrode dominate:
       a pad with poor contact carried 82 uV RMS of pure 60 Hz, the same magnitude
       as a real contraction. Fisher separability rest vs clench: 0.09 unweighted
       sum of three channels, 0.44 best single channel, 1.43 LDA-weighted sum of
       log-envelopes. Refit for your own placement with tools/fit_weights.py.

    4. CYTON, NOT CYTON+DAISY. Daisy interleaves two ADS1299 chips, so 16 channels
       land at 125 Hz each instead of 250. The ADS1299 sinc^3 decimation filter is
       -3 dB at 0.262 * f_DATA -- 33 Hz at 125 Hz vs 66 Hz at 250 Hz -- and sEMG
       median frequency is 50-100 Hz, so Daisy attenuates the middle of the signal.
       Force is one envelope, so extra channels buy nothing the bandwidth costs.
       NOTE: a Daisy may be physically attached and idle; BrainFlow's CYTON_BOARD
       mode still streams 8 channels at a measured 247.9 Hz.

    Emits the same (raw_aggregate, raw_per_channel) shape as MockEmgSource, so
    calibration.py normalizes it unchanged and the WS contract is untouched.
    """

    # LDA on log-envelopes. ch1 = FDS finger flexors (volar), ch2 = EDC finger
    # extensors (dorsal), ch4 = FCU. ch1 earns the largest weight despite being the
    # weakest alone (Fisher 0.08); ch4 earns a NEGATIVE weight because it is ~0.98
    # correlated with ch1 and so acts as a common-mode reference. Placement-specific
    # -- refit with tools/fit_weights.py against your own labelled session.
    DEFAULT_WEIGHTS = {1: 0.515, 2: 0.345, 4: -0.140}

    def __init__(self, serial_port: str, board: str = "cyton",
                 channels: Optional[List[int]] = None,
                 weights: Optional[dict] = None,
                 band: Optional[Tuple[float, float]] = None) -> None:
        import sys as _sys, pathlib as _pathlib
        _sys.path.insert(0, str(_pathlib.Path(__file__).resolve().parent))
        from scipy.signal import butter, iirnotch, tf2sos
        from obci import config as obci_config
        from obci.bridge import CytonBridge

        sel = sorted(channels or self.DEFAULT_WEIGHTS)
        self._bridge = CytonBridge(serial_port, board)
        # active= puts these channels in bipolar mode and powers down the rest.
        self._bridge.start_stream(active=sel)
        self._sampling_rate = self._bridge.sampling_rate
        exg = self._bridge.eeg_channels()

        sel = [c for c in sel if 1 <= c <= len(exg)] or [1]
        self._sel = sel
        self._rows = [exg[c - 1] for c in sel]
        self.num_channels = len(sel)
        self._shim = self._bridge._shim

        w = dict(weights or self.DEFAULT_WEIGHTS)
        self._w = [w.get(c, 0.0) for c in sel]
        if not any(self._w):
            self._w = [1.0 / len(sel)] * len(sel)

        lo, hi = band or obci_config.EMG_BANDPASS_HZ
        nyq = self._sampling_rate / 2.0
        hi = min(float(hi), nyq * 0.99)
        secs = [tf2sos(*iirnotch(f0, obci_config.NOTCH_Q, fs=self._sampling_rate))
                for f0 in (obci_config.NOTCH_FREQ_HZ, obci_config.NOTCH_FREQ_HZ * 2)
                if f0 < nyq]
        secs.append(butter(4, [float(lo) / nyq, hi / nyq], btype="band", output="sos"))
        self._sos = np.vstack(secs)
        self._zi = [np.zeros((self._sos.shape[0], 2)) for _ in sel]

        win_len = max(8, int(self._sampling_rate * 0.1))   # >=80 ms of moving RMS
        self._rms_buffers = [deque([0.0] * win_len, maxlen=win_len) for _ in sel]
        self._ema = [0.0 for _ in sel]
        self._alpha = 0.25

        print(f"[emg] {board} @ {self._sampling_rate} Hz  bipolar ch={sel}  "
              f"weights={[round(x, 3) for x in self._w]}  band={lo:g}-{hi:g} Hz", flush=True)

    def sample(self) -> Tuple[float, List[float]]:
        """Pull newly available board data and return (raw_aggregate, raw_per_channel)."""
        from scipy.signal import sosfilt

        data = self._shim.get_board_data()
        if getattr(data, "ndim", 0) == 2 and data.shape[1] > 0:
            for i, row in enumerate(self._rows):
                y, self._zi[i] = sosfilt(self._sos, data[row].astype(np.float64),
                                         zi=self._zi[i])
                self._rms_buffers[i].extend(y.tolist())
                rms = float(np.sqrt(np.mean(np.square(self._rms_buffers[i]))))
                self._ema[i] = self._alpha * rms + (1 - self._alpha) * self._ema[i]

        channels_env = list(self._ema)
        # Weighted sum of LOG envelopes -- EMG amplitude is roughly log-normal and
        # the LDA fit was performed in log space, so the weights only apply there.
        aggregate = float(sum(w * np.log(e + 1e-6) for w, e in zip(self._w, channels_env)))
        return aggregate, channels_env

    def close(self) -> None:
        try:
            self._bridge.release()
        except Exception:
            pass


class EmgBackend:
    """Owns the signal source, calibration state machine, and connected clients."""

    def __init__(self, source, num_channels: int,
                 gamma: float = DEFAULT_GAMMA,
                 deadzone: float = DEFAULT_DEADZONE) -> None:
        self.source = source
        self.num_channels = num_channels
        self.gamma = gamma
        self.deadzone = deadzone
        self.calib = MultiChannelCalibration(num_channels)
        self.mock = isinstance(source, MockEmgSource)
        self.state = "idle"  # idle | collecting_rest | collecting_max
        self._collect_start: Optional[float] = None
        self._collect_agg: List[float] = []
        self._collect_chan: List[List[float]] = [[] for _ in range(num_channels)]
        self.clients: set = set()

    def handle_cmd(self, cmd: str) -> None:
        """Apply a client control command: calibrate_rest | calibrate_max | reset."""
        if cmd == "calibrate_rest":
            self._start_collect("collecting_rest")
        elif cmd == "calibrate_max":
            self._start_collect("collecting_max")
        elif cmd == "reset":
            self.calib.reset()
            self.state = "idle"

    def _start_collect(self, state: str) -> None:
        self.state = state
        self._collect_start = time.monotonic()
        self._collect_agg = []
        self._collect_chan = [[] for _ in range(self.num_channels)]

    def tick(self) -> dict:
        """Advance one tick: sample the source, service calibration windows, emit EmgMessage dict."""
        boost = self.state == "collecting_max"
        agg, chans = self.source.sample(boost=boost) if self.mock else self.source.sample()

        if self.state in ("collecting_rest", "collecting_max"):
            self._collect_agg.append(agg)
            for i, v in enumerate(chans):
                self._collect_chan[i].append(v)
            assert self._collect_start is not None
            if time.monotonic() - self._collect_start >= CALIBRATION_WINDOW_S:
                if self.state == "collecting_rest":
                    self.calib.set_rest(self._collect_agg, self._collect_chan)
                else:
                    self.calib.set_max(self._collect_agg, self._collect_chan)
                self.state = "idle"

        return {
            "force": shape_force(self.calib.normalize_force(agg),
                                 self.gamma, self.deadzone),
            "perChannel": self.calib.normalize_channels(chans),
            "calibrated": self.calib.calibrated,
        }


async def _handle_client(websocket, backend: EmgBackend) -> None:
    """Register a connected client, service incoming control commands until disconnect."""
    backend.clients.add(websocket)
    try:
        async for raw in websocket:
            try:
                msg = json.loads(raw)
                cmd = msg.get("cmd")
                if cmd:
                    backend.handle_cmd(cmd)
            except (json.JSONDecodeError, AttributeError):
                continue
    finally:
        backend.clients.discard(websocket)


async def _broadcast_loop(backend: EmgBackend) -> None:
    """Tick the backend at ~40Hz and push the resulting EmgMessage JSON to all clients."""
    while True:
        start = time.monotonic()
        payload = json.dumps(backend.tick())
        dead = []
        for ws in list(backend.clients):
            try:
                await ws.send(payload)
            except websockets.exceptions.ConnectionClosed:
                dead.append(ws)
        for ws in dead:
            backend.clients.discard(ws)
        elapsed = time.monotonic() - start
        await asyncio.sleep(max(0.0, TICK_DT - elapsed))


async def _run(backend: EmgBackend) -> None:
    async with websockets.serve(lambda ws: _handle_client(ws, backend), HOST, PORT):
        print(f"EMG backend listening on ws://{HOST}:{PORT} (mock={backend.mock})")
        await _broadcast_loop(backend)


def main() -> None:
    parser = argparse.ArgumentParser(description="EMG backend WebSocket server (:6970).")
    parser.add_argument("--mock", action="store_true", help="Use synthetic data, no hardware/brainflow.")
    parser.add_argument("--serial-port", type=str, default=None, help="Serial port for the real BrainFlow board.")
    parser.add_argument("--board", choices=["cyton", "cyton_daisy"], default="cyton",
                        help="cyton = 8ch @ 250 Hz (default); cyton_daisy = 16ch @ 125 Hz, "
                             "which puts the ADS1299 -3 dB point at 33 Hz, below sEMG median frequency")
    parser.add_argument("--channels", default=None,
                        help="comma list of 1-based channels to combine (default: the weighted set 1,2,4)")
    parser.add_argument("--gamma", type=float, default=DEFAULT_GAMMA,
                        help="force response exponent; >1 is less sensitive (default 2.0)")
    parser.add_argument("--deadzone", type=float, default=DEFAULT_DEADZONE,
                        help="fraction of the low range suppressed before gamma (default 0.08)")
    parser.add_argument("--weights", default=None,
                        help="comma list of per-channel weights matching --channels; "
                             "omit to use the fitted LDA weights")
    args = parser.parse_args()

    if args.mock:
        source = MockEmgSource(MOCK_NUM_CHANNELS)
        backend = EmgBackend(source, MOCK_NUM_CHANNELS, args.gamma, args.deadzone)
    else:
        if not args.serial_port:
            parser.error("--serial-port is required unless --mock is given")
        chans = ([int(c) for c in args.channels.split(",") if c.strip()]
                 if args.channels else None)
        wts = None
        if args.weights:
            vals = [float(v) for v in args.weights.split(",") if v.strip()]
            if not chans or len(vals) != len(chans):
                parser.error("--weights must have one value per --channels entry")
            wts = dict(zip(chans, vals))
        source = RealEmgSource(args.serial_port, board=args.board,
                              channels=chans, weights=wts)
        backend = EmgBackend(source, source.num_channels, args.gamma, args.deadzone)

    try:
        asyncio.run(_run(backend))
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
