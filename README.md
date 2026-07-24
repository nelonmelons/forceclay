# Force Clay

A browser 3D-clay modeler where a webcam provides hand *position* and EMG (OpenBCI
Cyton+Daisy) provides *pressure/grip* — mold, squeeze, and physics-drop clay objects.
See `docs/superpowers/specs/2026-07-24-force-clay-design.md` for the full design and
`docs/superpowers/plans/2026-07-24-force-clay.md` for the implementation plan.

## Architecture

Three processes:

- **Vision backend** (`backend/webserver.py`) — Python/eventlet/MediaPipe, WebSocket on
  `ws://localhost:6969/ws`. Browser sends mirrored JPEG frames, gets back hand landmarks.
- **EMG backend** (`emg/emg_server.py`) — Python/BrainFlow, WebSocket on
  `ws://localhost:6970`. Streams normalized clench force (~40Hz); supports `--mock` for
  hardware-free dev.
- **Frontend** (`frontend/`) — React 19 + Vite + `@react-three/fiber` + Zustand + Rapier.
  Fuses both streams: camera = WHERE, EMG = HOW HARD.

Shared contracts (WS message shapes, store/API types, tuning constants) live in
`frontend/src/contracts.ts` and `frontend/src/types.ts` — the single source of truth for
all three processes.

## Running everything

### 1. Vision backend (`:6969`)

**Requires Python 3.12** — `mediapipe==0.10.21` has no wheel for Python 3.13+, so the venv
must be created with `python3.12` specifically (not whatever `python3` resolves to).

```bash
cd backend
python3.12 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
python webserver.py
```

### 2. EMG backend (`:6970`)

```bash
cd emg
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
python emg_server.py --mock   # no OpenBCI hardware required; --mock only needs numpy+websockets
# or, with a Cyton+Daisy board attached:
python emg_server.py --serial-port /dev/tty.usbserial-XXXX
```

### 3. Frontend (`:5173`)

```bash
cd frontend
npm install
npm run dev
```

Then open the printed local URL. The app renders and stays usable even with no camera and
no backends running — `getUserMedia`/WebSocket failures are caught, not thrown, and a
connection-status readout (bottom-left) shows camera / vision / EMG health at a glance so
you can tell what's actually connected.

### Calibration + demo loop

1. Once the EMG backend (or `--mock`) is connected, open the **CALIBRATION** panel
   (top-right): click **1. Calibrate rest** and hold your forearm relaxed for ~3s, then
   click **2. Calibrate max** and clench as hard as you comfortably can for ~3s. The panel
   flips to "Session calibrated" once `EmgMessage.calibrated` is true.
2. Press **`S`** (or click "Spawn clay", bottom-right) to spawn a sculptable clay sphere in
   front of the camera.
3. With a hand in view of the webcam: **open palm** molds/sculpts the clay under the
   camera-ray cursor (force ramps the heat-glow), **pinch** grabs it once clench force
   crosses the grab threshold (hysteresis release below it), and a hard clench while holding
   triggers a squash-and-stretch pulse. Releasing with hand motion throws the object; physics
   then drops/bounces it on the grid.

With no hardware attached, `emg_server.py --mock` alone (no camera) is enough to see the
HUD's force meter move and to exercise grab/squash by wiggling the mock force.

## Build / typecheck

```bash
cd frontend
npm run build   # tsc -b && vite build
```

## Repo layout

```
forceclay/
  backend/            # vision (MediaPipe, :6969)
  emg/                # EMG backend (BrainFlow, :6970)
  frontend/            # React + R3F + Zustand + Rapier
  docs/superpowers/{specs,plans}/
  scripts/mock_hand.ts # synthetic HandState generator for offline frontend dev
```
