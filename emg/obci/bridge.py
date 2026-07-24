"""CytonBridge — a thin, stateful wrapper over BrainFlow for the OpenBCI Cyton.

The MCP server keeps ONE CytonBridge instance alive across tool calls, so the
serial session + streaming ring buffer persist between requests.

BrainFlow is imported lazily so the CSV-only analysis path still works on a
machine where BrainFlow isn't installed.
"""
from __future__ import annotations

import glob
import time

import numpy as np

from . import config
from .recording import Recording


class BridgeError(RuntimeError):
    pass


def list_serial_ports() -> list[dict]:
    """Enumerate serial ports (pyserial if available, plus /dev/cu.* on macOS)."""
    ports: list[dict] = []
    try:
        from serial.tools import list_ports as _lp
        for p in _lp.comports():
            ports.append({
                "device": p.device,
                "description": p.description,
                "manufacturer": getattr(p, "manufacturer", None),
            })
    except Exception:
        pass
    seen = {p["device"] for p in ports}
    for dev in sorted(glob.glob("/dev/cu.*")):
        if dev not in seen:
            ports.append({"device": dev, "description": None, "manufacturer": None})
    for p in ports:                       # heuristic: FTDI usbserial == OpenBCI dongle
        p["likely_openbci"] = "usbserial" in p["device"]
    return ports


class CytonBridge:
    def __init__(self, serial_port: str | None = None, board: str | None = None):
        self.serial_port = serial_port or config.DEFAULT_SERIAL_PORT
        self.board = (board or config.DEFAULT_BOARD).lower()
        if self.board not in config.BOARD_SAMPLING_RATE:
            raise BridgeError(f"Unknown board '{self.board}'. Use 'cyton' or 'cyton_daisy'.")
        self._shim = None
        self._streaming = False
        self._started_at: float | None = None

    # --- lazy BrainFlow import ---------------------------------------------
    def _ids(self):
        try:
            from brainflow.board_shim import BoardShim, BrainFlowInputParams, BoardIds
        except Exception as e:
            raise BridgeError(
                "BrainFlow is not installed or failed to import. Run "
                "`pip install brainflow`, or use the CSV fallback "
                "(analyze.py on an OpenBCI GUI .txt recording)."
            ) from e
        bid = BoardIds.CYTON_DAISY_BOARD if self.board == "cyton_daisy" else BoardIds.CYTON_BOARD
        return BoardShim, BrainFlowInputParams, int(bid)

    # --- introspection ------------------------------------------------------
    @property
    def sampling_rate(self) -> int:
        if self._shim is not None:
            BoardShim, _, bid = self._ids()
            return int(BoardShim.get_sampling_rate(bid))
        return config.BOARD_SAMPLING_RATE[self.board]

    def eeg_channels(self) -> list[int]:
        BoardShim, _, bid = self._ids()
        return list(BoardShim.get_eeg_channels(bid))

    def _timestamp_channel(self) -> int:
        BoardShim, _, bid = self._ids()
        return int(BoardShim.get_timestamp_channel(bid))

    # --- lifecycle ----------------------------------------------------------
    def prepare(self) -> None:
        if self._shim is not None:
            return
        BoardShim, BrainFlowInputParams, bid = self._ids()
        params = BrainFlowInputParams()
        params.serial_port = self.serial_port
        shim = BoardShim(bid, params)
        try:
            shim.prepare_session()
        except Exception as e:
            raise BridgeError(
                f"Could not open the Cyton on '{self.serial_port}'. "
                f"Check: dongle plugged in, Cyton powered on (switch to PC), "
                f"and the OpenBCI GUI is CLOSED (it locks the serial port). "
                f"Underlying error: {e}"
            ) from e
        self._shim = shim

    # Cyton firmware channel on/off shortcut commands.
    _CH_ON = {1: "!", 2: "@", 3: "#", 4: "$", 5: "%", 6: "^", 7: "&", 8: "*"}
    _CH_OFF = {1: "1", 2: "2", 3: "3", 4: "4", 5: "5", 6: "6", 7: "7", 8: "8"}

    def configure_channels(self, active, srb2: bool = False) -> None:
        """Configure `active` (1-based) channels and power down the rest.

        Active channels are set up as **bipolar** differential pairs by default
        (srb2=False): each channel measures its own INxP vs INxN, which is the
        montage the electrodes are wired for (NxP + NxN per channel). The Cyton
        firmware default is SRB2-ON, where every channel is referenced to the
        shared (often unwired -> floating) SRB2 rail instead, which reads as
        ~100% 60 Hz hum on every connected channel.

        Full per-channel command:  x CH PWR GAIN INPUT BIAS SRB2 SRB1 X
        (PWR 0=on/1=off, GAIN 6=24x, INPUT 0=normal, BIAS 1=include).
        Must run after prepare_session() and before start_stream().
        """
        if active is None:
            return
        self.prepare()
        active = {int(c) for c in active}
        s2 = "1" if srb2 else "0"
        for ch in range(1, 9):
            if ch in active:
                cmd = f"x{ch}060{1}{s2}0X"   # on, 24x, normal, bias=on, srb2, srb1=off
            else:
                cmd = f"x{ch}160000X"         # powered down
            resp = None
            for attempt in range(3):          # Cyton drops config cmds over RF; retry
                try:
                    resp = self._shim.config_board(cmd)
                except Exception as e:
                    resp = f"<err {e}>"
                time.sleep(0.25)              # let the board apply each command
                if resp and "success" in str(resp).lower():
                    break
            print(f"[cfg] ch{ch} cmd={cmd}  resp={resp!r}", flush=True)

    def start_stream(self, ring_buffer_samples: int = 450000, active=None) -> None:
        self.prepare()
        self.configure_channels(active)
        if not self._streaming:
            self._shim.start_stream(ring_buffer_samples)
            self._streaming = True
            self._started_at = time.time()

    def stop_stream(self) -> None:
        if self._shim is not None and self._streaming:
            self._shim.stop_stream()
            self._streaming = False

    def release(self) -> None:
        if self._shim is not None:
            try:
                if self._streaming:
                    self._shim.stop_stream()
            finally:
                try:
                    self._shim.release_session()
                except Exception:
                    pass
        self._shim = None
        self._streaming = False

    # --- data ---------------------------------------------------------------
    def _to_recording(self, data, label: str) -> Recording:
        fs = self.sampling_rate
        eeg = self.eeg_channels()
        ts_row = self._timestamp_channel()
        channels = {
            i + 1: np.asarray(data[ch], dtype=float) for i, ch in enumerate(eeg)
        }
        n = data.shape[1] if data.ndim == 2 else 0
        if data.ndim == 2 and data.shape[0] > ts_row:
            ts = np.asarray(data[ts_row], dtype=float)
        else:
            ts = np.array([])
        if ts.size == 0 or np.all(ts == 0):
            ts = np.arange(n) / fs
        return Recording(fs=fs, timestamps=ts, channels=channels,
                         label=label, source="brainflow", board=self.board)

    def get_recent(self, seconds: float) -> Recording:
        """Latest `seconds` of data WITHOUT clearing the buffer."""
        if self._shim is None:
            raise BridgeError("No session. Call start_openbci_stream() first.")
        n = max(1, int(seconds * self.sampling_rate))
        data = self._shim.get_current_board_data(n)
        return self._to_recording(data, label=f"recent_{seconds:g}s")

    def record(self, duration_seconds: float, label: str) -> Recording:
        """Flush buffer, stream for `duration_seconds`, return the captured chunk."""
        self.start_stream()
        self._shim.get_board_data()                 # flush stale samples
        time.sleep(duration_seconds)
        data = self._shim.get_board_data()          # pull + clear
        return self._to_recording(data, label=label)

    # --- status -------------------------------------------------------------
    def status(self) -> dict:
        info = {
            "serial_port": self.serial_port,
            "board": self.board,
            "expected_sampling_rate_hz": config.BOARD_SAMPLING_RATE[self.board],
            "session_prepared": self._shim is not None,
            "streaming": self._streaming,
            "stream_uptime_s": (round(time.time() - self._started_at, 1)
                                if self._started_at and self._streaming else None),
        }
        if self._shim is not None:
            try:
                info["samples_buffered"] = int(self._shim.get_board_data_count())
                info["sampling_rate_hz"] = self.sampling_rate
                info["eeg_channel_rows"] = self.eeg_channels()
            except Exception as e:
                info["warning"] = str(e)
        return info
