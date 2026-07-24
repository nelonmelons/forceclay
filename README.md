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

```bash
cd backend
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
python webserver.py
```

### 2. EMG backend (`:6970`)

```bash
cd emg
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
python emg_server.py --mock   # no OpenBCI hardware required
# or, with a Cyton+Daisy board attached:
python emg_server.py --serial-port /dev/tty.usbserial-XXXX
```

### 3. Frontend (`:5173`)

```bash
cd frontend
npm install
npm run dev
```

Then open the printed local URL. The frontend expects both backends running for the full
experience; with no vision/EMG backends it still builds and renders the empty scene (and
`scripts/mock_hand.ts` can drive a synthetic hand for offline UI dev).

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
