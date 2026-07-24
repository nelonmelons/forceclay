# Force Clay Implementation Plan

> **For agentic workers:** This plan is built for a **parallel Sonnet-subagent fan-out**. Task 0 (scaffold + shared contracts) is a **barrier** — it must complete before anything else. Tasks A–F then run in parallel because they depend only on the pinned contracts in §Shared Contracts, not on each other. Integration tasks run last. Steps use checkbox (`- [ ]`) syntax.

**Goal:** A browser 3D-clay modeler where the webcam provides hand *position* and EMG (OpenBCI Cyton+Daisy) provides *pressure/grip*, enabling molding, squeeze, and physics-based pick-up/drop of clay objects.

**Architecture:** Three processes mirroring ShapeShift's known-working data flow — a MediaPipe vision backend (`:6969`), a new BrainFlow EMG backend (`:6970`), and a React+R3F+Zustand+Rapier frontend that fuses both streams. Camera = WHERE (raycast-to-surface), EMG = HOW HARD. Single r3f render path (deliberate simplification of ShapeShift's dual renderer).

**Tech Stack:** Python (eventlet, mediapipe, opencv, orjson, brainflow, numpy, scikit-learn); TypeScript, Vite, React 19, three 0.180, @react-three/fiber 9.3, @react-three/drei 10.7, @react-three/rapier, three-mesh-bvh, zustand 5 + immer.

## Global Constraints

- **Reference implementation:** `~/Desktop/shapeshift`. Mirror its patterns (WS protocol, MediaPipe params, capture pipeline, store model) but write our own code — do not copy-paste.
- **Vision backend contract is fixed** (§Shared Contracts). Vision WS on `ws://localhost:6969/ws`. EMG WS on `ws://localhost:6970`.
- **MediaPipe params (verbatim):** `Hands(static_image_mode=False, max_num_hands=2, min_detection_confidence=0.65, min_tracking_confidence=0.65)`; resize frames to 640×360; 50 ms frame budget → `{"status":"dropped"}`.
- **EMG:** never hardcode force thresholds — per-session rest+max calibration. Bandpass 20–60 Hz + 60 Hz notch → rectify → 100 ms RMS → EMA. Support a `--mock` mode (no hardware) emitting synthetic force.
- **Every subagent writing TS/JS:** concise JSDoc — 1–2 sentence summary + `@remarks` for rationale only where non-obvious; inline comments ≤2 lines. Match ShapeShift's style.
- **Verification is smoke/run-it**, not unit-TDD, for real-time/visual/hardware code. Each task states its verification command.
- **Commit after each task** with a clear message.

---

## File Structure

```
forceclay/
  backend/
    webserver.py            # eventlet WS :6969, MediaPipe pipeline (Task A)
    requirements.txt
  emg/
    emg_server.py           # BrainFlow → envelope → WS :6970, --mock (Task B)
    calibration.py          # rest/max normalization (Task B)
    classifier.py           # LDA mode classifier, stretch (Task B-stretch)
    requirements.txt
  frontend/
    package.json, vite.config.ts, tsconfig.json, index.html
    src/
      main.tsx, App.tsx
      types.ts                       # SHARED types — SceneObject, HandState, EmgState (Task 0)
      contracts.ts                    # SHARED WS message shapes + constants (Task 0)
      store/editor.ts                 # Zustand + immer scene store (Task C)
      providers/
        VisionSocket.tsx              # :6969 capture+recv, imperative getters (Task C)
        EmgSocket.tsx                 # :6970 recv force, imperative getter (Task C)
        VideoStream.tsx               # getUserMedia + captureFrame (Task C)
      hands/useSkeleton.ts            # landmarks → HandState (cursor/pinch/open) (Task C)
      scene/
        Viewport.tsx                  # r3f Canvas, camera, grid, lights (Task C)
        ClayObject.tsx                # renders a SceneObject (Task C)
        HandCursor.tsx                # 3D brush cursor + heat glow (Task F)
      sculpt/
        brush.ts                      # BVH radius query + vertex displacement (Task D)
        geometry.ts                   # subdivided icosphere, serialize/deserialize (Task D)
      physics/
        PhysicsWorld.tsx              # Rapier <Physics>, grab/drop/squash (Task E)
      control/
        useFusion.ts                  # fuses HandState + EmgState → actions (Task F)
      ui/
        ForceHUD.tsx                  # force meter overlay (Task F)
        CalibrationPanel.tsx          # rest/max flow trigger (Task F)
  docs/superpowers/{specs,plans}/
  README.md
  scripts/mock_hand.ts               # optional synthetic HandState for offline dev (Task 0)
```

---

## Shared Contracts (pinned — every task depends on these, tasks depend on nothing else)

`frontend/src/contracts.ts` and `frontend/src/types.ts` (created in Task 0). Backends must match these exactly.

```typescript
// ---- Vision WS (:6969) server→client, mirrors ShapeShift ----
export interface VisionMessage {
  status: "success" | "dropped";
  hands?: VisionHand[];
  image_size?: { width: number; height: number };
}
export interface VisionHand {
  handedness: "Left" | "Right";
  landmarks: [number, number, number][]; // 21 × [x_px(0..640), y_px(0..360), z_rel]
  connections: [number, number][];
}
// client→server: raw JPEG ArrayBuffer, quality ~0.5, mirrored, 640×360.

// ---- EMG WS (:6970) server→client, ~40Hz push ----
export interface EmgMessage {
  force: number;              // 0..1 normalized clench (primary signal)
  perChannel: number[];       // 0..1 per electrode (visuals), length 8 or 16
  mode?: "sculpt" | "grab" | "smooth" | "spawn" | "idle"; // LDA, stretch; may be absent
  calibrated: boolean;        // false until rest+max done
  fatigue?: number;           // 0..1 median-freq drop, stretch
}
// client→server (control): {"cmd":"calibrate_rest"} | {"cmd":"calibrate_max"} | {"cmd":"reset"}

// ---- Fused per-frame hand state (useSkeleton output) ----
export interface HandState {
  present: boolean;
  cursorPx: { x: number; y: number };   // in 640×360, smoothed (EMA 0.2)
  cursorNdc: { x: number; y: number };  // -1..1 for raycasting
  depthProxy: number;                   // 1 - handDiag/canvasDiag
  isPinching: boolean;
  isOpen: boolean;
}

// ---- Scene store model (mirrors ShapeShift SceneObject) ----
export type GeometryKind = "box"|"sphere"|"cylinder"|"cone"|"torus"|"plane"|"custom";
export interface SerializableGeometry { positions: number[]; indices: number[]; normals: number[]; }
export interface SceneObject {
  id: string; name: string;
  geometry: GeometryKind;
  geometryParams?: Record<string, number>;
  customGeometry?: SerializableGeometry;   // when geometry === "custom"
  position: [number, number, number];
  rotation: [number, number, number];
  scale: [number, number, number];
  material: { color: string; metalness: number; roughness: number; emissive: string; emissiveIntensity: number };
  physics: "fixed" | "dynamic";            // fixed while sculpting, dynamic when dropped
  visible: boolean;
}

// ---- Store API (Task C) consumed by D/E/F ----
export interface EditorStore {
  objects: SceneObject[];
  selectedId: string | null;
  addObject(partial: Partial<SceneObject> & { geometry: GeometryKind }): string; // returns id
  select(id: string | null): void;
  updateTransform(id: string, t: Partial<Pick<SceneObject,"position"|"rotation"|"scale">>): void;
  updateGeometry(id: string, geo: SerializableGeometry): void;
  updateMaterial(id: string, m: Partial<SceneObject["material"]>): void;
  setPhysics(id: string, p: "fixed" | "dynamic"): void;
  deleteSelected(): void;
  undo(): void; redo(): void;
}

// ---- Sculpt API (Task D) consumed by F ----
// applyBrush(geo, hitPointLocal, normalLocal, radius, force, dir): SerializableGeometry
//   dir: -1 press in, +1 pull out (taffy). Uses three-mesh-bvh for radius query.
// makeClaySphere(radius, detail): SerializableGeometry   // subdivided icosphere

// ---- Fusion constants ----
export const VISION_WS = "ws://localhost:6969/ws";
export const EMG_WS = "ws://localhost:6970";
export const GRAB_FORCE_ON = 0.45;   // clench above → grab
export const GRAB_FORCE_OFF = 0.25;  // release below → drop (hysteresis)
export const BRUSH_RADIUS = 0.4;
export const SCULPT_STRENGTH = 0.15;
```

---

## Task 0: Scaffold + Shared Contracts (BARRIER — run first, alone)

**Files:** create the whole tree skeleton, `frontend/package.json`, Vite/TS config, `types.ts`, `contracts.ts` (verbatim from §Shared Contracts), empty stub files for each module with the exported signatures above, `backend/requirements.txt`, `emg/requirements.txt`, `README.md`, `scripts/mock_hand.ts`.

- [ ] Scaffold Vite React-TS frontend; install `three @react-three/fiber @react-three/drei @react-three/rapier three-mesh-bvh zustand immer`.
- [ ] Write `contracts.ts` and `types.ts` exactly as §Shared Contracts.
- [ ] Create stub modules exporting the pinned signatures (throwing `notImplemented`) so parallel tasks compile against real types.
- [ ] `backend/requirements.txt`: `mediapipe==0.10.21 opencv-contrib-python numpy eventlet flask flask-cors orjson`. `emg/requirements.txt`: `brainflow numpy scikit-learn`.
- [ ] **Verify:** `cd frontend && npm run build` compiles (stubs + types). Commit `"chore: scaffold + shared contracts"`.

---

## Parallel Tasks A–F (depend ONLY on Task 0 contracts)

### Task A: Vision backend (`backend/webserver.py`)
Mirror ShapeShift exactly. eventlet monkey-patch + `WebSocketWSGI` on `:6969` path `/ws`. Decode JPEG bytes → resize 640×360 → RGB → MediaPipe Hands (params verbatim) → dedup to first Left+Right → emit `VisionMessage` (§contract). 50 ms budget → `{"status":"dropped"}`. Drop ShapeShift's symbol/template matcher.
- [ ] **Verify:** run `python backend/webserver.py`; a tiny test client sends one JPEG, receives a well-formed `VisionMessage` with 21-landmark hands. Commit.

### Task B: EMG backend (`emg/emg_server.py` + `calibration.py`)
BrainFlow (`BoardIds.CYTON_DAISY_BOARD`) OR `--mock`. Pipeline: bandpass 20–60 + 60 Hz notch → rectify → 100 ms RMS (updated ~40 Hz) → EMA → normalize via calibration → emit `EmgMessage` on `:6970`. Handle `{"cmd":"calibrate_rest|calibrate_max|reset"}`. `--mock` emits synthetic force (slow sine + noise, jumps on stdin) so frontend devs need no hardware.
- [ ] **Verify:** `python emg/emg_server.py --mock`; a test client connects, runs calibrate_rest then calibrate_max, sees `calibrated:true` and `force` in 0..1. Commit.

### Task C: Frontend core (providers, store, scene, skeleton)
`VisionSocket.tsx` (capture mirrored JPEG @0.5, request/response backpressure, auto-reconnect, imperative getters), `EmgSocket.tsx` (recv `EmgMessage`, imperative getter, send calibrate cmds), `VideoStream.tsx` (getUserMedia 640×360 + captureFrame), `useSkeleton.ts` (landmarks → `HandState`, cursor EMA 0.2, pinch/open per §contract), `store/editor.ts` (full `EditorStore`), `scene/Viewport.tsx` (Canvas, PerspectiveCamera at (0,3,5), Grid, lights), `scene/ClayObject.tsx` (render SceneObject incl. custom geometry).
- [ ] **Verify:** `npm run dev` shows the r3f scene; with Vision backend running, the mirrored camera PIP tracks hands and a debug dot follows the cursor; store `addObject` renders a sphere. Commit.

### Task D: Sculpt system (`sculpt/geometry.ts`, `sculpt/brush.ts`)
`makeClaySphere(radius, detail)` → subdivided icosphere `SerializableGeometry`. `applyBrush(geo, hitPointLocal, normalLocal, radius, force, dir)` — build/reuse a three-mesh-bvh, gather verts within radius, displace `v += normal·force·SCULPT_STRENGTH·smoothstep_falloff(dist)·dir`, recompute normals, return new `SerializableGeometry`. Pure functions — testable offline against a mock mesh.
- [ ] **Verify:** a small node/vitest harness calls `applyBrush` on a clay sphere and asserts vertices near the hit point moved inward and normals recomputed. Commit.

### Task E: Physics (`physics/PhysicsWorld.tsx`)
Wrap scene in Rapier `<Physics>`. Each `SceneObject` with `physics:"dynamic"` → `RigidBody` (convex-hull collider from its geometry); `physics:"fixed"` → fixed body. Expose `grab(id, handWorldPos)` (set kinematic, follow point), `release(id, velocity)` (→ dynamic, gravity, inherit velocity for throw), `squash(id, force)` (scale squash-and-stretch, ease back on release).
- [ ] **Verify:** dev scene with a dynamic sphere falls under gravity and bounces on the grid; calling grab/release from a debug button picks it up and drops it. Commit.

### Task F: Fusion controller + HUD + heat glow (`control/useFusion.ts`, `ui/ForceHUD.tsx`, `ui/CalibrationPanel.tsx`, `scene/HandCursor.tsx`)
`useFusion` runs per-frame: read `HandState` (VisionSocket+useSkeleton) + `EmgMessage` (EmgSocket); raycast camera→cursorNdc to find surface hit; dispatch by mode (camera-pose fallback: open=sculpt, pinch=grab, palm=smooth): **sculpt** → `applyBrush` + `updateGeometry` + ramp `emissiveIntensity` with force (heat glow); **grab** → hysteresis `GRAB_FORCE_ON/OFF` → physics grab/release; **squash** on hard in-hand clench. `ForceHUD` shows the force meter + mode. `CalibrationPanel` triggers rest/max. `HandCursor` draws the brush sphere, colored/sized by force.
- [ ] **Verify:** end-to-end with `--mock` EMG — mock force ramp visibly molds a sphere and glows hot; pinch+force grabs and drop lets it fall. Commit.

---

## Integration + Enhancements (after A–F merge)

### Task G: End-to-end integration pass
Wire all providers in `App.tsx`; run all three processes; fix contract mismatches; tune constants (`BRUSH_RADIUS`, `SCULPT_STRENGTH`, grab thresholds). **Verify:** full demo loop (spawn → mold → grab → squeeze → drop) works with `--mock`, then with real board if available. Commit.

### Task H: Stamp/imprint + Taffy pull (approved enhancements)
Stamp: press object B into object A → subtract B's cross-section footprint into A's brush region (reuse `applyBrush` with the presser's radius/shape). Taffy: pinch a surface + pull hand away → `applyBrush` with `dir:+1` following the hand, stretching strands. **Verify:** stamping leaves an impression; pulling stretches. Commit.

### Task I (stretch): Throw physics, LDA classifier, fatigue, two-handed scale
Per spec §7, only if time. Each independently committable.

---

## Self-Review

- **Spec coverage:** molding (D/F), grab-drop physics (E/F), squeeze (E/F), spawn (C/F), calibration (B/F), heat glow (F), stamp+taffy (H), force HUD (F), mirrored-camera base + WS protocol + store model (A/C) — all mapped. Stretch items (throw/fatigue/LDA/scale) → Task I.
- **Placeholder scan:** none — each task names exact files, contracts, and a concrete verification command.
- **Type consistency:** all tasks consume the single pinned `contracts.ts`/`types.ts`; store/sculpt/physics/fusion APIs match §Shared Contracts signatures.
- **Parallel safety:** A–F share no files (distinct directories) and depend only on Task 0. Mock EMG (`--mock`) + Vision backend decouple frontend work from hardware.
