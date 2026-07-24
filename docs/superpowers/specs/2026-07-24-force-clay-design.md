# Force Clay — Design Spec

**Date:** 2026-07-24
**Status:** Approved design, pre-implementation
**Hardware:** OpenBCI Cyton + Daisy (16-channel EMG, 125 Hz) on forearm; standard webcam.

## 1. One-line pitch

ShapeShift lets you *point* at 3D objects with your hands. **Force Clay** lets you *press into them*: the webcam says **where** your hand is, your muscles (EMG) say **how hard**. You mold, squeeze, pick up, and drop clay with real analog pressure — a dimension a camera-only tool physically cannot sense.

The point of EMG here: pressure sensing makes shaping **personal and analog**. A light touch is a subtle nudge; a hard press is a deep gouge. That continuous force range, plus real grip strength for picking up and squeezing objects, is exactly what ShapeShift (camera-only) structurally cannot feel.

## 2. Why EMG and not just a camera (the defensible thesis)

- **Cameras own WHERE:** absolute hand position, pose, which object. They are good at this and EMG is bad at it (no absolute position, drift, per-user calibration).
- **EMG owns HOW HARD:** force/effort, isometric pressure (force with no visible movement — a camera sees zero signal during a constant-pose squeeze), grip strength, and pre-movement intent (~30–100 ms before motion, the electromechanical delay).
- Credibility anchor: Meta/CTRL-labs' 2025 *Nature* neuromotor interface used a **16-channel EMG wristband** — same channel count as our board — and explicitly decodes force and intent.

Design rule that follows: **never make EMG a worse camera.** Every EMG-driven mechanic (mold depth, grip, squash) is about *force*, never about *position*. Position always comes from the camera.

## 3. Architecture — three processes

Mirrors ShapeShift's proven data flow. Two of the three processes replicate ShapeShift patterns; the EMG backend is new.

```
┌─ Vision backend (Python, port 6969) ─┐
│  Raw eventlet WebSocket.              │  Browser sends JPEG frames → MediaPipe Hands →
│  ShapeShift's exact pattern, our code.│  returns landmarks + hand pose. Client computes pinch/grab.
└───────────────────────────────────────┘
┌─ EMG backend (Python, port 6970) ────┐   NEW
│  BrainFlow ← Cyton+Daisy.             │  bandpass+notch → rectify → RMS envelope → EMA →
│  Streams force @ ~40 Hz over WS.      │  normalized 0..1 force  (+ LDA mode classifier, stretch)
└───────────────────────────────────────┘
┌─ Frontend (React + R3F + Zustand) ───┐
│  + @react-three/rapier (physics)      │  Fuses BOTH streams in one control loop:
│  + three-mesh-bvh (brush query)       │  camera = WHERE (raycast-to-surface), EMG = HOW HARD.
└───────────────────────────────────────┘
```

### 3.1 What we replicate from ShapeShift (known-working base — do not reinvent)

The base must match ShapeShift because it is a project known to work. Replicate these patterns (writing our own code, not copying theirs):

**Vision backend (`backend/`):**
- Stack: `eventlet` (monkey-patched) + `flask` (a couple HTTP routes) + `eventlet.websocket.WebSocketWSGI` + `orjson`. Listen on `0.0.0.0:6969`, WebSocket path `/ws`.
- MediaPipe: `mp.solutions.hands.Hands(static_image_mode=False, max_num_hands=2, min_detection_confidence=0.65, min_tracking_confidence=0.65)`.
- Per message: browser sends a **JPEG frame as raw bytes** (ArrayBuffer, quality ~0.5). Server `cv2.imdecode` → resize to **640×360** → BGR→RGB → `hands.process`.
- Frame-skipping: **50 ms wall-clock budget**; if exceeded at any checkpoint, send `{"status": "dropped"}` and skip. Request/response (one result per frame the client sends), not a fixed emit rate.
- Handedness dedup: keep only the first Left and first Right hand.
- Response format (server → client):
  ```json
  { "status": "success",
    "hands": [ { "handedness": "Left|Right",
                 "landmarks": [[x_px, y_px, z], ...21],
                 "connections": [[a,b], ...],
                 "detected_symbols": [[name, score], ...] } ],
    "image_size": { "width": 640, "height": 360 } }
  ```
  We may drop `detected_symbols` (ShapeShift's cosine-similarity template matcher) since EMG + camera poses cover our modes.

**Client-side gesture detection (`useSkeleton` pattern):**
- Cursor = midpoint of thumb tip (landmark 4) and index tip (8), exponentially smoothed (factor 0.2).
- Depth proxy = `1 - handDiagonal / canvasDiagonal` (bigger hand on screen = closer).
- `isPinching` = thumb–index distance below `0.25 * handSpread`, stable (low std-dev) over ~50 ms.
- `isOpen` / pose class for the camera-pose mode fallback.
- Interaction state exposed as an imperative ref (not React state) to avoid re-render churn.

**Frontend base:**
- React 19 + Vite 7 + TypeScript, three 0.180, `@react-three/fiber` 9.3, `@react-three/drei` 10.7, `zustand` 5 + `immer`, `three-mesh-bvh` 0.9 (already used for spatial queries).
- WebSocket wiring: `WebSocketContext` exposes imperative getters (`sendFrame`, `getData`, `getAcknowledged`, `getConnectionStatus`); **request/response backpressure** — only send the next frame once the last result arrived; auto-reconnect every 3 s; watchdog resets the "acknowledged" flag if the server stalls.
- Frame capture: `VideoStreamContext.captureFrame()` draws the `getUserMedia` `<video>` (640×360) to an offscreen canvas **mirrored**, exports JPEG @0.5 as ArrayBuffer.
- Store: `useEditor` (Zustand + immer). `SceneObject = { id, name, geometry: GeometryKind, geometryParams, position, rotation, scale, material{color,metalness,roughness,opacity}, visible, locked }`. `GeometryKind = box|sphere|cylinder|cone|torus|plane|custom`; deformed clay stored as `custom` (`SerializableGeometry`: positions/indices/normals/uvs arrays). Actions: `addObject`, `deleteSelected`, `select`, `updateTransform`, `updateGeometry`, `updateMaterial`, undo/redo via deep-cloned snapshots pushed to `past`.

### 3.2 Deliberate deviations from ShapeShift (improvements)

1. **Single render path.** ShapeShift has two tangled renderers (a clean r3f `Viewport` *and* a messy imperative raw-Three renderer). We consolidate on **one r3f `Viewport`**, because Rapier physics needs a single consistent loop. Simpler, and everything reconciles from the Zustand store.
2. **Raycast-to-surface for depth.** ShapeShift guesses 3D depth from 2D hand size (fragile). We instead raycast from the camera through the hand cursor and act at **the surface the ray hits** — depth is never ambiguous because you always sculpt the surface in front of you.
3. **Add physics** (`@react-three/rapier`) for grab/drop/throw/squash — ShapeShift has none.
4. **Add the EMG backend + fusion controller** — the whole point.

## 4. The fusion controller (the heart)

One control loop per frame reads both streams and decides the action:

- **Camera → 3D brush point:** raycast from camera through the (smoothed) hand cursor; the brush/grab acts at the surface hit point.
- **EMG force (0..1) → magnitude:** the analog "pressure."
- **Mode (sculpt / grab / smooth / spawn):** from the LDA classifier **when confident**, with a **camera-pose fallback** (open hand = sculpt, pinch = grab, flat palm = smooth) so the demo never dies if the classifier is flaky on stage.

## 5. EMG signal path

Flexor electrodes → BrainFlow (`BoardIds.CYTON_DAISY_BOARD`, serial port, USB dongle) → bandpass 20–60 Hz (Butterworth) + 60 Hz notch → rectify → **100 ms RMS window updated ~40 Hz** → EMA smooth (α ≈ 0.2–0.3) → normalize to calibrated max = **proportional force 0..1**.

- **Calibration (mandatory, per session):** 3 s rest (baseline) + 3 s max clench (ceiling) → map to 0..1. Never hardcode thresholds — amplitude varies wildly by person/placement/session.
- **Reference/ground electrodes required** (SRB/BIAS on a bony, quiet spot) or 60 Hz swamps the signal.
- **125 Hz note:** the Daisy runs 16 ch at 125 Hz, which undersamples true EMG spectrum but is fine for amplitude *envelopes*. 16 channels also give a spatial activation map useful for visuals. If the classifier struggles, fall back to Cyton-only 8 ch @ 250 Hz.
- **LDA classifier (stretch):** Hudgins time-domain features (MAV, waveform length, zero-crossings, slope-sign changes) per channel per window → mode. Trains in ms with ~15 reps/gesture. Built *behind* the camera-pose fallback; single riskiest piece, must be non-blocking.

## 6. Core features

### MVP (the demo — the whole "whoa")
1. **3D hand cursor + Force HUD.** Glowing brush at the ray-hit point; an on-screen meter of clench force so viewers *see* the pressure climb (legibility matters on stage).
2. **Pressure molding** ⭐ signature. Point at a surface, clench → vertices under the brush push in, depth = `force × strength × falloff`. Light touch = subtle, hard press = deep gouge. three-mesh-bvh does the "verts near the brush" query. Result serialized to `custom` geometry (ShapeShift's pattern) so undo works.
3. **Grab & drop with physics** ⭐ requested. Pinch + clench over an object → it goes kinematic and follows the hand. Release clench → dynamic → Rapier gravity → it falls, bounces, rolls. Pick up a ball, drop it.
4. **Squeeze-to-squash.** Grip an in-hand object hard → it squishes proportional to force (scale-based squash-and-stretch), springs back on release. Cheap but sells the pressure/clay feel instantly.
5. **Spawn clay.** A gesture/key drops a fresh subdivided-sphere blob.
6. **Calibration flow.** 3 s rest + 3 s max-clench → per-session normalize (see §5).

### Deformation detail (mesh sculpt-brush)
- Base clay = subdivided icosphere (~2–5k verts). three-mesh-bvh for the radius query.
- Brush at hit point `p`, radius `r`: for each vertex within `r`, `v += normal · force · strength · smoothstep_falloff(dist)`; recompute normals → reads as clay. Press-in by default; grab-and-pull = bulge out (additive; taffy pull, §7).
- **Physics/sculpt separation (perf-critical):** while sculpting, the object is fixed (no physics). Grab/drop/squash use a **convex-hull or bounding collider**, not the live concave mesh — keeps Rapier fast.

### Approved enhancements (in scope)
7. 🔥 **Heat glow** — harder press makes the clay glow hot at the contact point (emissive ramps with force). Free force-legibility + gorgeous.
8. 🩹 **Stamp / imprint** — press one object into the clay to leave its impression (the brush footprint takes the presser's cross-section, or a boolean-subtract stamp of the object).
9. 🥢 **Taffy pull** — pinch a surface and pull to stretch strands (grab-and-pull additive displacement / vertex dragging away from the surface).

## 7. Stretch / "if time" flexes
- 🎯 **Throw physics** — grab, swing fast, release → Rapier inherits velocity → throw the ball. Nearly free with Rapier.
- 😮‍💨 **Fatigue mechanic** — EMG spectral fatigue (median-frequency drop) weakens the brush as the muscle tires. Genuinely impossible without EMG; memorable flex.
- **LDA gesture classifier** for hands-free mode switching (§5).
- **Two-handed scale** (ShapeShift's dual-hand distance → scale).
- **Smooth brush** (average neighbor vertices).
- **Save/export** mesh (`file-saver`), **AI text-to-model** base mesh (`@fal-ai/client`), **material/color by force**.

## 8. New dependencies
- Frontend: `@react-three/rapier`. (three-mesh-bvh already present in the ShapeShift stack we mirror.)
- Backend: `brainflow`; `scikit-learn` (classifier, stretch).

## 9. Risks & mitigations
| Risk | Mitigation |
|---|---|
| 3D depth / "reaching in" is hard | Raycast-to-surface: sculpt the surface the ray hits, never free 3D positioning. |
| EMG classifier fragile on stage | Camera-pose fallback for modes; proportional force (the star) needs no classifier. |
| 125 Hz undersampling | Fine for envelopes; fall back to Cyton-only 250 Hz if classifier needs it. |
| Physics + live-deforming mesh perf | Separate sculpt (fixed, no physics) from physics (convex collider) states. |
| Two WebSocket streams timing | Both consumed as imperative refs, fused in the render loop; EMG pushes ~40 Hz, vision is request/response. |
| EMG noise / 60 Hz | Bandpass + notch + proper ground/reference; per-session calibration; keep leads taped and away from power bricks. |

## 10. Repo layout (fresh git repo at `~/Desktop/forceclay`)
```
forceclay/
  backend/            # vision (MediaPipe, :6969) — mirrors ShapeShift
  emg/                # EMG backend (BrainFlow, :6970) — new
  frontend/           # React + R3F + Zustand + Rapier
  docs/superpowers/specs/
  README.md
```

## 11. Demo script (what we show judges)
1. Spawn a clay blob. 2. Mold it — light vs hard press visibly different (heat glow ramps). 3. Pick it up (pinch + clench), it follows the hand. 4. Squeeze it — it squashes. 5. Drop / throw it — Rapier gravity, bounce. 6. Stamp another object into it. Narration: *"the camera knows where my hand is; my muscles know how hard I'm pressing — that second axis is the whole thing."*
