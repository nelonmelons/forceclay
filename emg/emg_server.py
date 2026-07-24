"""EMG backend (Task B) -- BrainFlow (or --mock) WebSocket server on :6970.

Contract (must match frontend/src/contracts.ts EmgMessage exactly):

  Server -> client, pushed at ~40Hz:
    {
      "force": 0.0..1.0,          # normalized clench, primary signal
      "perChannel": [0.0..1.0, ...],  # length 8 (mock) or 16 (Cyton+Daisy)
      "calibrated": bool           # false until rest+max calibration has run this session
      # "mode" and "fatigue" are omitted entirely -- not implemented yet.
    }

  Client -> server (control messages, JSON):
    {"cmd": "calibrate_rest"} | {"cmd": "calibrate_max"} | {"cmd": "reset"}

Pipeline: BrainFlow (BoardIds.CYTON_DAISY_BOARD, serial port) OR --mock (synthetic force:
slow sine + noise + occasional spikes, no hardware required) ->
bandpass 20-60 Hz (Butterworth) + 60 Hz notch -> rectify -> 100 ms RMS window
(recomputed ~40Hz) -> EMA smoothing (alpha ~= 0.25) -> normalize via per-session
rest/max calibration (calibration.py, ~1.2s collection windows) -> emit EmgMessage.

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
    """BrainFlow CYTON_DAISY_BOARD envelope source: bandpass+notch -> rectify -> RMS -> EMA.

    @remarks brainflow is imported here (inside __init__/sample), never at module
    top level, so `--mock` never requires it to be installed.
    """

    def __init__(self, serial_port: str) -> None:
        from brainflow.board_shim import BoardIds, BoardShim, BrainFlowInputParams

        self._BoardShim = BoardShim
        self._board_id = BoardIds.CYTON_DAISY_BOARD.value

        params = BrainFlowInputParams()
        params.serial_port = serial_port
        self._board = BoardShim(self._board_id, params)
        self._board.prepare_session()
        self._board.start_stream()

        try:
            self._emg_channels = BoardShim.get_emg_channels(self._board_id)
        except Exception:
            self._emg_channels = BoardShim.get_exg_channels(self._board_id)
        self._sampling_rate = BoardShim.get_sampling_rate(self._board_id)
        self.num_channels = len(self._emg_channels)

        window_len = max(1, int(self._sampling_rate * 0.1))
        self._rms_buffers = [deque(maxlen=window_len) for _ in self._emg_channels]
        self._ema = [0.0 for _ in self._emg_channels]
        self._alpha = 0.25

    def sample(self) -> Tuple[float, List[float]]:
        """Pull newly available board data and return (raw_aggregate, raw_per_channel)."""
        from brainflow.data_filter import DataFilter, FilterTypes

        data = self._board.get_board_data()
        if data.shape[1] > 0:
            for i, ch in enumerate(self._emg_channels):
                sig = data[ch].astype(np.float64).copy()
                # Bandpass 20-60 Hz: center=40, bandwidth=40.
                DataFilter.perform_bandpass(
                    sig, self._sampling_rate, 40.0, 40.0, 4,
                    FilterTypes.BUTTERWORTH.value, 0,
                )
                # Notch around 60 Hz mains noise.
                DataFilter.perform_bandstop(
                    sig, self._sampling_rate, 60.0, 4.0, 4,
                    FilterTypes.BUTTERWORTH.value, 0,
                )
                rectified = np.abs(sig)
                self._rms_buffers[i].extend(rectified.tolist())
                rms = float(np.sqrt(np.mean(np.square(self._rms_buffers[i])))) if self._rms_buffers[i] else 0.0
                self._ema[i] = self._alpha * rms + (1 - self._alpha) * self._ema[i]

        channels_env = list(self._ema)
        aggregate = float(np.mean(channels_env)) if channels_env else 0.0
        return aggregate, channels_env


class EmgBackend:
    """Owns the signal source, calibration state machine, and connected clients."""

    def __init__(self, source, num_channels: int) -> None:
        self.source = source
        self.num_channels = num_channels
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
            "force": self.calib.normalize_force(agg),
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
    args = parser.parse_args()

    if args.mock:
        source = MockEmgSource(MOCK_NUM_CHANNELS)
        backend = EmgBackend(source, MOCK_NUM_CHANNELS)
    else:
        if not args.serial_port:
            parser.error("--serial-port is required unless --mock is given")
        source = RealEmgSource(args.serial_port)
        backend = EmgBackend(source, source.num_channels)

    try:
        asyncio.run(_run(backend))
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
