/**
 * Per-frame fusion controller: reads `TwoHandState` + `EmgMessage`, raycasts camera->cursor to
 * a surface hit, and dispatches behavior by `interactionMode` (the store's single source of
 * truth for what interaction currently means).
 * @remarks Two independent gesture systems run every frame, mirroring ShapeShift exactly:
 * - Camera navigation (always on, in every mode): one hand `isHolding` (thumb-index pinch)
 *   orbit-rotates the camera; both hands `isHolding` pans (from the left hand's cursor delta)
 *   and dollies (from the change in inter-hand distance). See `scene/cameraGestures.ts`.
 * - Object interaction is keyed off `useEditor`'s `interactionMode`. `"warp"` sculpting and the
 *   hover/proximity ray still use the *primary* hand (`hands/useSkeleton.ts`'s `getPrimaryHand` —
 *   right hand, falling back to left), but grab/carry/manipulate is hand-agnostic — EITHER hand
 *   can pick an object up:
 *   - `"warp"` is the ONLY mode that reads/uses EMG `force` — it sculpts (press-in) the hovered
 *     object and pins it on first deform so it doesn't fall while being worked.
 *   - `"select"`/`"physics"` grab/carry via either hand's `isPinching` (all-5-fingertip cluster;
 *     no force gating): whichever hand is pinching over a target when nothing is held starts the
 *     grab (right wins if both pinch at once), tracked in a `heldHand` ref; while held, carry and
 *     release follow THAT specific hand's cursor/pinch, not always the primary hand. Hold-to-pin:
 *     holding the carry point within a small radius for ~1.5s auto-pins the object in place
 *     (monotonic progress; a "pinch consumed" latch stops the same pinch from instantly
 *     re-grabbing the just-pinned object). Objects do NOT rotate with the hand while carried (no
 *     twist-to-rotate here — see `"rotate"` below).
 *   - `"delete"` hover-highlights the object under the cursor (via `useFusionStatus`) and
 *     removes it on pinch (primary hand).
 *   - `"move"` is gizmo-owned; this hook does not grab in that mode.
 *   - `"rotate"`/`"scale"` pinch-grab the hovered/target object (same proximity-target logic as
 *     `"select"`, evaluated per-hand) with either hand, and pin it for the duration of the
 *     manipulation so it doesn't fall. Camera navigation is fully disabled in these two modes so
 *     both hands are free for manipulation. Rotate: one hand pinching twists the object about the
 *     camera's forward axis by that hand's roll delta (switching which hand is driving re-snapshots
 *     the baseline so it doesn't jump); both hands pinching instead tilts/twists it about an
 *     arbitrary axis derived from the change in the vector between the two hands (cursor + depth).
 *     Scale: uniform-scales the object by an exponential function of the grabbing hand's
 *     depth-proxy delta since grab-start (pulling the hand back grows the object). Neither mode
 *     translates the object. The mouse gizmo keeps working alongside hand manipulation in both.
 *   - `"edit"` is vertex-handle-owned (`VertexEditHandles`); this hook does not grab/sculpt.
 *
 * Must be called from a component mounted *inside* the r3f `<Canvas>` (it uses `useFrame`/
 * `useThree`) and inside `VisionSocketProvider` + `EmgSocketProvider`. This is also the single
 * call site for `useSkeleton` (see `hands/useSkeleton.ts`'s module-level EMA/pinch-history
 * state) — the computed `TwoHandState` is mirrored into `control/useHandState.ts` each frame so
 * other components (e.g. `VertexEditHandles`) can read it without a second call site.
 *
 * Raycast hit -> `SceneObject` id resolution assumes `ClayObject` (Task C) stamps
 * `mesh.userData.objectId` on the meshes it renders; this walks up the ancestor chain to be
 * resilient to wrapper groups, and simply no-ops (no sculpt/grab) if nothing is tagged.
 */
import { useEffect, useRef, useState } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import * as THREE from "three";
import { useVisionSocket } from "../providers/VisionSocket";
import { useEmgSocket } from "../providers/EmgSocket";
import { useSkeleton, getPrimaryHand, FRAME_WIDTH, FRAME_HEIGHT } from "../hands/useSkeleton";
import { useEditor } from "../store/editor";
import { applyBrush } from "../sculpt/brush";
import { grab, release, pin, getBodyPosition, setBodyRotation } from "../physics/PhysicsWorld";
import { BRUSH_RADIUS } from "../contracts";
import { useFusionStatus } from "./fusionStatus";
import { useHandState } from "./useHandState";
import { orbitRotate, orbitPan, orbitDolly } from "../scene/cameraGestures";
import type { HandInfo, InteractionMode } from "../types";

/** Which hand (if any) currently owns a grab/manipulation. */
type HandSide = "left" | "right";

export { useFusionStatus } from "./fusionStatus";

/** Result handed back to the caller each render for driving `HandCursor`. */
export interface FusionFrame {
  position: [number, number, number];
  force: number;
  mode: InteractionMode;
  hasHit: boolean;
}

/** World-space radius the carry point must stay within to keep charging hold-to-pin. Judged
 *  against the RAW (pre-lerp) drag target, not the smoothed carry position — the smoothed
 *  position keeps creeping toward the target every frame under the `CARRY_LERP`, which at a
 *  tight radius spuriously looked like "jitter" and reset the timer forever. */
const PIN_RADIUS = 0.22;
/** Seconds the carry point must stay within `PIN_RADIUS` before auto-pinning. */
const PIN_DURATION = 1.5;
/** Smoothing for the carried object's position (ShapeShift lerps ~0.1; lower = smoother/laggier). */
const CARRY_LERP = 0.2;
/** Per-frame carry delta → release/throw velocity (units/sec). */
const THROW_GAIN = 40;
/** Screen-space (NDC) radius within which an object counts as hovered/grabbable when the ray
 *  doesn't land a direct hit — mirrors ShapeShift's `pointer.distanceTo(pos2D) < TOLERANCE`
 *  proximity highlight. Generous so a noisy hand cursor can still target a small object. */
const PROXIMITY_NDC = 0.28;
/** Ignore hand-roll deltas smaller than this (radians) so micro-jitter doesn't dribble rotation. */
const ROTATE_DEADZONE = 0.01;
/** Uniform-scale clamp bounds (multiplier of the object's scale at grab-start). */
const SCALE_MIN = 0.2;
const SCALE_MAX = 5;
/** Two-hand rotate: how much weight `depthProxy` gets as the "z" component of each hand's
 *  cursor+depth vector, relative to NDC's -1..1 xy range — picked so a natural push/pull
 *  produces a z swing comparable to an xy swing across the frame. */
const ROTATE_2HAND_DEPTH_SCALE = 1.5;
/** Minimum inter-hand vector length (in the same units as above) below which two-hand rotation
 *  is skipped — hands too close together make the vector's direction numerically unstable. */
const ROTATE_2HAND_MIN_VEC = 1e-3;
/** Sculpt writes are throttled to roughly this many Hz to keep BVH rebuilds affordable. */
const SCULPT_HZ = 30;
/** Warm emissive color clay ramps toward as sculpt force rises. */
const HOT_COLOR = new THREE.Color("#ff6a1f");
const COLD_COLOR = new THREE.Color("#000000");

/** Shortest-path angular difference `a - b`, wrapped to (-PI, PI]; used for roll-delta rotation
 *  so the wrap seam at +-PI never produces a spurious full-circle jump. */
function angleDiff(a: number, b: number): number {
  let d = a - b;
  while (d > Math.PI) d -= 2 * Math.PI;
  while (d < -Math.PI) d += 2 * Math.PI;
  return d;
}

/** Walks up from `obj` looking for a `userData.objectId` tag (set by `ClayObject`). */
function findObjectId(obj: THREE.Object3D | null): string | null {
  let cur: THREE.Object3D | null = obj;
  while (cur) {
    if (typeof cur.userData?.objectId === "string") return cur.userData.objectId;
    cur = cur.parent;
  }
  return null;
}

/**
 * Runs the fusion loop once per frame. Call from a component rendered inside the Canvas;
 * returns the current hit position/force/mode for driving `HandCursor`.
 */
export function useFusion(): FusionFrame {
  const { camera, scene } = useThree();
  const vision = useVisionSocket();
  const emg = useEmgSocket();
  const editor = useEditor();

  const raycaster = useRef(new THREE.Raycaster()).current;
  // Plain state (not a ref) so the caller's component re-renders and can hand fresh
  // position/force down to <HandCursor> as props; acceptable cost for one small mesh.
  const [frame, setFrame] = useState<FusionFrame>({ position: [0, 0, 0], force: 0, mode: "select", hasHit: false });
  const heldId = useRef<string | null>(null);
  /** Which hand (`"left"`/`"right"`) is currently carrying `heldId.current` in `"select"`/
   *  `"physics"` mode — grab/carry/release all follow THIS hand, not the primary hand, so either
   *  hand can pick objects up. Null while nothing is held. */
  const heldHand = useRef<HandSide | null>(null);
  const lastSculptTime = useRef(0);
  const holdStartPos = useRef<THREE.Vector3 | null>(null);
  const holdStartTime = useRef(0);
  const wasPinching = useRef(false);
  /** ShapeShift-style carry state: camera-facing drag plane, grab offset, and smoothed carry point. */
  const dragPlane = useRef(new THREE.Plane());
  const dragOffset = useRef(new THREE.Vector3());
  const carryPos = useRef(new THREE.Vector3());
  const lastCarryPos = useRef(new THREE.Vector3());
  /** Latches true the instant hold-to-pin auto-pins an object, so the SAME still-active pinch
   *  can't immediately re-grab it and restart the timer at 0. Clears the moment the hand
   *  un-pinches (or drops out of frame). */
  const pinchConsumed = useRef(false);
  /** Which hand's still-active pinch set `pinchConsumed`, so the latch clears the moment THAT
   *  hand un-pinches rather than depending on the primary hand. */
  const pinchConsumedHand = useRef<HandSide | null>(null);
  /** `"rotate"`/`"scale"` pinch-manipulation state: the object currently grabbed, plus the
   *  hand-pose and object-pose snapshots taken at grab-start that each frame's delta is measured
   *  against (avoids drift from accumulating small per-frame deltas). */
  const manipId = useRef<string | null>(null);
  /** `"rotate"` single-hand twist: which hand is currently driving it, so switching hands
   *  re-snapshots the roll baseline instead of jumping. Unused in two-hand rotate/scale. */
  const manipHand = useRef<HandSide | null>(null);
  const manipStartRoll = useRef(0);
  const manipStartRotation = useRef<[number, number, number]>([0, 0, 0]);
  /** `"scale"` two-hand pinch-distance snapshot: inter-hand screen distance and the object's
   *  scale at the moment both hands started pinching together. */
  const scaleInitialDist = useRef(0);
  const scaleInitialScale = useRef<[number, number, number]>([1, 1, 1]);
  /** Two-hand rotate: previous frame's (right-hand - left-hand) cursor+depth vector, for
   *  deriving an arbitrary-axis delta rotation. Null whenever both hands aren't pinching. */
  const prevInterHandVec = useRef<THREE.Vector3 | null>(null);
  /** Previous-frame cursor positions (px) for each holding hand, and previous inter-hand
   *  distance (px), used to derive per-frame deltas for camera rotate/pan/dolly. Reset to null
   *  whenever that hand stops holding. */
  const prevLeftCursor = useRef<{ x: number; y: number } | null>(null);
  const prevRightCursor = useRef<{ x: number; y: number } | null>(null);
  const prevHandDist = useRef<number | null>(null);

  // `useSkeleton` is a hook and must be called at the top level on every render, not from
  // inside the `useFrame` callback. Vision arrives at camera-capture cadence (well under
  // 60fps), so a modest re-render tick is enough to keep the derived `TwoHandState` fresh; the
  // raycast/physics/sculpt work below still runs every animation frame via `useFrame`.
  const [, tick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => tick((t) => (t + 1) % 1_000_000), 33);
    return () => clearInterval(id);
  }, []);
  const hands = useSkeleton(vision.getData()?.hands);
  const hand = getPrimaryHand(hands);
  useEffect(() => {
    useHandState.setState(hands);
  }, [hands]);

  useFrame((state) => {
    const interactionMode = useEditor.getState().interactionMode;
    const emgData = emg.getData();
    const force = interactionMode === "warp" ? (emgData?.force ?? 0) : 0;
    const calibrated = emgData?.calibrated ?? false;

    let hasHit = false;
    let hitWorld: THREE.Vector3 | null = null;
    let hitObjectId: string | null = null;
    let hitLocal: [number, number, number] = [0, 0, 0];
    let normalLocal: [number, number, number] = [0, 0, 1];

    // Camera navigation runs in every mode EXCEPT "rotate"/"scale", independent of the
    // mode-branch below: one hand holding (thumb-index pinch, stable ~50ms) orbits the camera;
    // both hands holding pans (from the left hand's delta) and dollies (from the change in
    // inter-hand distance). Mirrors ShapeShift's HolohandsOverlay per-frame wiring exactly.
    // A grab cluster (isPinching, all 5 fingertips) also satisfies isHolding (thumb-index), so
    // exclude pinching hands from camera-nav — otherwise picking an object up also rotates the
    // camera. No deadzone here — mirrors ShapeShift's HolohandsOverlay exactly, which applies
    // orbitPan/orbitDolly/orbitRotate unconditionally to the raw per-frame cursor delta; adding
    // a deadzone made nav feel dead/laggy instead of preventing drift.
    if (interactionMode === "rotate" || interactionMode === "scale") {
      // In these two modes both hands are dedicated to manipulating the grabbed object, not the
      // camera — a pinch/twist/pull must never also pan/zoom/orbit the view. Reset trackers so
      // nav doesn't see a stale delta and jump the moment it's re-enabled in another mode.
      prevLeftCursor.current = null;
      prevRightCursor.current = null;
      prevHandDist.current = null;
    } else {
      const leftHold = (hands.left?.isHolding ?? false) && !(hands.left?.isPinching ?? false);
      const rightHold = (hands.right?.isHolding ?? false) && !(hands.right?.isPinching ?? false);
      if (leftHold && rightHold && hands.left && hands.right) {
        const L = hands.left.cursorPx;
        const R = hands.right.cursorPx;
        const prevL = prevLeftCursor.current;
        const dxN = (L.x - (prevL?.x ?? L.x)) / FRAME_WIDTH;
        const dyN = (L.y - (prevL?.y ?? L.y)) / FRAME_HEIGHT;
        orbitPan(dxN, dyN);
        prevLeftCursor.current = { x: L.x, y: L.y };

        const currDist = Math.hypot(R.x - L.x, R.y - L.y);
        if (prevHandDist.current != null) {
          const deltaZoom = (prevHandDist.current - currDist) / FRAME_WIDTH;
          orbitDolly(deltaZoom);
        }
        prevHandDist.current = currDist;
        prevRightCursor.current = { x: R.x, y: R.y };
      } else if ((leftHold && hands.left) || (rightHold && hands.right)) {
        const H = rightHold ? hands.right! : hands.left!;
        const prev = rightHold ? prevRightCursor.current : prevLeftCursor.current;
        const dxN = (H.cursorPx.x - (prev?.x ?? H.cursorPx.x)) / FRAME_WIDTH;
        const dyN = (H.cursorPx.y - (prev?.y ?? H.cursorPx.y)) / FRAME_HEIGHT;
        orbitRotate(dxN, dyN);
        if (rightHold) prevRightCursor.current = { x: H.cursorPx.x, y: H.cursorPx.y };
        else prevLeftCursor.current = { x: H.cursorPx.x, y: H.cursorPx.y };
        prevHandDist.current = null;
      } else {
        prevLeftCursor.current = null;
        prevRightCursor.current = null;
        prevHandDist.current = null;
      }
    }

    if (hand) {
      try {
        raycaster.setFromCamera(new THREE.Vector2(hand.cursorNdc.x, hand.cursorNdc.y), camera);
        const hits = raycaster.intersectObjects(scene.children, true);
        const first = hits.find((h) => h.face);
        if (first && first.face) {
          hasHit = true;
          hitWorld = first.point.clone();
          hitObjectId = findObjectId(first.object);

          const worldNormal = first.face.normal.clone().transformDirection(first.object.matrixWorld).normalize();
          const invMatrix = new THREE.Matrix4().copy(first.object.matrixWorld).invert();
          const localPoint = first.object.worldToLocal(hitWorld.clone());
          const localNormal = worldNormal.clone().transformDirection(invMatrix).normalize();
          hitLocal = [localPoint.x, localPoint.y, localPoint.z];
          normalLocal = [localNormal.x, localNormal.y, localNormal.z];
        }
      } catch {
        // Raycast against a still-empty/unready scene graph; treat as no hit this frame.
        hasHit = false;
      }
    }

    // Forgiving hover/grab target (primary hand, used for the hover cue + two-hand grab starts):
    // exact ray hit if any, else the object whose screen-projected center is nearest the primary
    // hand's cursor within PROXIMITY_NDC (ShapeShift's NDC-distance highlight). Per-hand grab
    // targeting (so either hand can pick things up) is done separately by `resolveHandTarget`.
    let targetId: string | null = hitObjectId;
    if (!targetId && hand) {
      let best = PROXIMITY_NDC;
      for (const o of editor.objects) {
        if (!o.visible) continue;
        const bp = getBodyPosition(o.id);
        const center = bp
          ? new THREE.Vector3(bp[0], bp[1], bp[2])
          : new THREE.Vector3(o.position[0], o.position[1], o.position[2]);
        const ndc = center.clone().project(camera);
        const d = Math.hypot(ndc.x - hand.cursorNdc.x, ndc.y - hand.cursorNdc.y);
        if (d < best) {
          best = d;
          targetId = o.id;
        }
      }
    }
    const hoveredObjectId = targetId;
    let pinProgress = 0;
    let pinningId: string | null = null;

    // The "pinch consumed" latch (set the instant hold-to-pin auto-pins something) only clears
    // once the SAME hand that triggered it actually un-pinches — checked once per frame,
    // independent of mode, so it can't get stuck latched if the mode changes mid-pinch.
    {
      const consumedSide = pinchConsumedHand.current;
      const stillPinching = consumedSide ? (hands[consumedSide]?.isPinching ?? false) : false;
      if (!stillPinching) {
        pinchConsumed.current = false;
        pinchConsumedHand.current = null;
      }
    }

    // Resolves a grab/manipulate target for a SPECIFIC hand (rather than only the primary hand):
    // reuses the primary hand's exact ray hit when `info` IS the primary hand, otherwise falls
    // back to the same NDC-proximity search `targetId` above uses, keyed to that hand's cursor.
    const resolveHandTarget = (info: HandInfo): { id: string; world: THREE.Vector3 } | null => {
      if (info === hand && hitObjectId && hitWorld) {
        return { id: hitObjectId, world: hitWorld.clone() };
      }
      let bestId: string | null = null;
      let bestWorld: THREE.Vector3 | null = null;
      let best = PROXIMITY_NDC;
      for (const o of editor.objects) {
        if (!o.visible) continue;
        const bp = getBodyPosition(o.id);
        const center = bp
          ? new THREE.Vector3(bp[0], bp[1], bp[2])
          : new THREE.Vector3(o.position[0], o.position[1], o.position[2]);
        const ndc = center.clone().project(camera);
        const d = Math.hypot(ndc.x - info.cursorNdc.x, ndc.y - info.cursorNdc.y);
        if (d < best) {
          best = d;
          bestId = o.id;
          bestWorld = center;
        }
      }
      return bestId && bestWorld ? { id: bestId, world: bestWorld } : null;
    };

    if (interactionMode !== "select" && interactionMode !== "physics" && heldId.current) {
      // Left a grab-capable mode while still holding something — drop it where it is.
      try {
        release(heldId.current, [0, 0, 0]);
      } catch {
        // ignore
      } finally {
        heldId.current = null;
        heldHand.current = null;
        holdStartPos.current = null;
      }
    }
    if (interactionMode !== "rotate" && interactionMode !== "scale" && manipId.current) {
      // Left rotate/scale mode mid-manipulation — leave the object pinned where it is and just
      // drop our tracking so re-entering the mode starts a fresh grab instead of applying a
      // stale delta.
      manipId.current = null;
      manipHand.current = null;
      prevInterHandVec.current = null;
    }

    if (interactionMode === "warp") {
      const now = state.clock.getElapsedTime();
      const dueSculpt = now - lastSculptTime.current >= 1 / SCULPT_HZ;
      if (hasHit && hitObjectId && force > 0 && dueSculpt) {
        const obj = editor.objects.find((o) => o.id === hitObjectId);
        if (obj?.geometry === "custom" && obj.customGeometry) {
          try {
            if (obj.physics !== "fixed") pin(hitObjectId);
            const nextGeo = applyBrush(obj.customGeometry, hitLocal, normalLocal, BRUSH_RADIUS, force, -1);
            editor.updateGeometry(hitObjectId, nextGeo);
            const warm = COLD_COLOR.clone().lerp(HOT_COLOR, force);
            editor.updateMaterial(hitObjectId, {
              emissive: `#${warm.getHexString()}`,
              emissiveIntensity: force,
            });
            lastSculptTime.current = now;
          } catch {
            // Neighbor sculpt/store implementations may still be stubs; don't crash the loop.
          }
        }
      }
    } else if (interactionMode === "select" || interactionMode === "physics") {
      // Carry mechanic mirrors ShapeShift's ThreeRenderer drag: on grab, fix a camera-facing
      // plane through the object and record the grab offset; each frame move the object to
      // ray∩plane + offset (+ hand-depth push/pull), smoothed with a position lerp so a noisy
      // hand cursor doesn't jitter the object. No raw ray-hit-follow (that fed back on itself).
      try {
        if (!heldId.current) {
          // Either hand can start a grab: whichever hand is pinching over a target wins; if
          // BOTH are pinching at once, the right hand wins (mirrors the old primary-hand default).
          const leftPinching = hands.left?.isPinching ?? false;
          const rightPinching = hands.right?.isPinching ?? false;
          const grabSide: HandSide | null = rightPinching ? "right" : leftPinching ? "left" : null;
          const grabHandInfo = grabSide ? hands[grabSide] : null;
          if (grabSide && grabHandInfo && !pinchConsumed.current) {
            const target = resolveHandTarget(grabHandInfo);
            if (target) {
              const objWorld = target.world;
              const camForward = camera.getWorldDirection(new THREE.Vector3());
              dragPlane.current.setFromNormalAndCoplanarPoint(camForward, objWorld);
              raycaster.setFromCamera(new THREE.Vector2(grabHandInfo.cursorNdc.x, grabHandInfo.cursorNdc.y), camera);
              const planePt = new THREE.Vector3();
              if (raycaster.ray.intersectPlane(dragPlane.current, planePt)) {
                dragOffset.current.copy(objWorld).sub(planePt);
              } else {
                dragOffset.current.set(0, 0, 0);
              }
              carryPos.current.copy(objWorld);
              lastCarryPos.current.copy(objWorld);
              grab(target.id, [objWorld.x, objWorld.y, objWorld.z]);
              heldId.current = target.id;
              heldHand.current = grabSide;
              holdStartPos.current = null;
            }
          }
        } else {
          const held = heldId.current;
          const carryHand = heldHand.current ? hands[heldHand.current] : null;
          if (!carryHand || !carryHand.isPinching) {
            const velocity = carryPos.current.clone().sub(lastCarryPos.current).multiplyScalar(THROW_GAIN);
            release(held, [velocity.x, velocity.y, velocity.z]);
            heldId.current = null;
            heldHand.current = null;
            holdStartPos.current = null;
          } else {
            // Follow the drag plane, smoothed. lastCarryPos is captured before the lerp so the
            // per-frame delta doubles as throw velocity on release.
            raycaster.setFromCamera(new THREE.Vector2(carryHand.cursorNdc.x, carryHand.cursorNdc.y), camera);
            // Carry on the fixed camera-facing drag plane only. (No hand-depth push/pull: the
            // hand-size depth proxy is too noisy and made held objects drift toward the camera —
            // "enlarge" — on their own. The plane keeps a stable grab depth.)
            const target = new THREE.Vector3();
            let rawTarget: THREE.Vector3 | null = null;
            if (raycaster.ray.intersectPlane(dragPlane.current, target)) {
              target.add(dragOffset.current);
              rawTarget = target;
              lastCarryPos.current.copy(carryPos.current);
              carryPos.current.lerp(target, CARRY_LERP);
              grab(held, [carryPos.current.x, carryPos.current.y, carryPos.current.z]);
            }

            // Hold-to-pin, judged on the RAW (pre-lerp) drag target rather than the smoothed
            // carry position: under a steady hold, `carryPos` keeps creeping toward the target
            // every frame (CARRY_LERP never fully catches up), which at the old tight radius
            // read as "jitter" and reset the timer before it could ever reach 100%. The raw
            // target has no such creep, so a genuinely steady hand advances progress
            // monotonically to 1.0 exactly once, instead of looping.
            const now = state.clock.getElapsedTime();
            const stabilityPoint = rawTarget ?? carryPos.current;
            if (!holdStartPos.current) {
              holdStartPos.current = stabilityPoint.clone();
              holdStartTime.current = now;
            } else if (holdStartPos.current.distanceTo(stabilityPoint) > PIN_RADIUS) {
              holdStartPos.current = stabilityPoint.clone();
              holdStartTime.current = now;
            } else {
              const progress = Math.min((now - holdStartTime.current) / PIN_DURATION, 1);
              pinProgress = progress;
              pinningId = held;
              if (progress >= 1) {
                pin(held);
                // The hand is very likely still pinching this exact frame — latch so the
                // grab-start branch above can't immediately re-grab the object we just pinned
                // and restart the hold-to-pin timer from 0. Clears on the next un-pinch of
                // THIS hand (see `pinchConsumedHand`).
                pinchConsumed.current = true;
                pinchConsumedHand.current = heldHand.current;
                heldId.current = null;
                heldHand.current = null;
                holdStartPos.current = null;
                pinProgress = 0;
                pinningId = null;
              }
            }
          }
        }
      } catch {
        // Physics stubs may still throw notImplemented; fusion loop stays alive regardless.
      }
    } else if (interactionMode === "rotate") {
      // Pinch-twist/tilt: grab the hovered/target object (same proximity logic as select/grab,
      // evaluated per-hand so either hand can start it), pin it so it doesn't fall, then rotate
      // it with the hand(s). No translation.
      // - One hand pinching: twist (hand roll) rotates about the camera's forward axis only.
      //   Measured from a grab-start snapshot (not accumulated per-frame) so floating-point/
      //   roll-wrap error can't drift the object over a long hold. Switching which hand is
      //   driving (including a two-hand -> one-hand handoff) re-snapshots this baseline.
      // - Both hands pinching: tilting/twisting the pair rotates about an arbitrary axis,
      //   derived from how the vector between the two hands (cursor + depth) changes frame to
      //   frame. This one IS incremental (each frame's delta composed onto the live rotation)
      //   since "distance from a start vector" isn't a stable baseline the way roll-from-start is.
      try {
        const leftPinch = hands.left?.isPinching ?? false;
        const rightPinch = hands.right?.isPinching ?? false;
        const twoHandPinch = leftPinch && rightPinch && !!hands.left && !!hands.right;
        const singleSide: HandSide | null = twoHandPinch ? null : rightPinch ? "right" : leftPinch ? "left" : null;
        const singleHand = singleSide ? hands[singleSide] : null;

        if (!manipId.current) {
          if (twoHandPinch && targetId) {
            pin(targetId);
            manipId.current = targetId;
            manipHand.current = null;
            manipStartRoll.current = hand?.roll ?? 0;
            const obj = editor.objects.find((o) => o.id === targetId);
            manipStartRotation.current = obj ? [...obj.rotation] : [0, 0, 0];
            prevInterHandVec.current = null;
          } else if (singleSide && singleHand) {
            const target = resolveHandTarget(singleHand);
            if (target) {
              pin(target.id);
              manipId.current = target.id;
              manipHand.current = singleSide;
              manipStartRoll.current = singleHand.roll;
              const obj = editor.objects.find((o) => o.id === target.id);
              manipStartRotation.current = obj ? [...obj.rotation] : [0, 0, 0];
              prevInterHandVec.current = null;
            }
          }
        } else if (twoHandPinch) {
          manipHand.current = null;
          const L = hands.left!;
          const R = hands.right!;
          const leftVec = new THREE.Vector3(L.cursorNdc.x, L.cursorNdc.y, L.depthProxy * ROTATE_2HAND_DEPTH_SCALE);
          const rightVec = new THREE.Vector3(R.cursorNdc.x, R.cursorNdc.y, R.depthProxy * ROTATE_2HAND_DEPTH_SCALE);
          const interHandVec = rightVec.sub(leftVec);
          const prevVec = prevInterHandVec.current;
          if (prevVec && interHandVec.length() > ROTATE_2HAND_MIN_VEC && prevVec.length() > ROTATE_2HAND_MIN_VEC) {
            const deltaQuat = new THREE.Quaternion().setFromUnitVectors(
              prevVec.clone().normalize(),
              interHandVec.clone().normalize(),
            );
            const angle = 2 * Math.acos(THREE.MathUtils.clamp(deltaQuat.w, -1, 1));
            if (angle > ROTATE_DEADZONE) {
              const obj = editor.objects.find((o) => o.id === manipId.current);
              if (obj) {
                const currentQuat = new THREE.Quaternion().setFromEuler(new THREE.Euler(...obj.rotation));
                const nextQuat = deltaQuat.multiply(currentQuat);
                const nextEuler = new THREE.Euler().setFromQuaternion(nextQuat);
                const rotation: [number, number, number] = [nextEuler.x, nextEuler.y, nextEuler.z];
                editor.updateTransform(manipId.current, { rotation });
                setBodyRotation(manipId.current, rotation);
              }
            }
          }
          prevInterHandVec.current = interHandVec;
        } else if (singleSide && singleHand) {
          if (manipHand.current !== singleSide) {
            // Switched which hand is driving (from two-hand, or a hand-to-hand handoff) —
            // re-snapshot the baseline against the object's CURRENT pose so the switch doesn't jump.
            manipStartRoll.current = singleHand.roll;
            const obj = editor.objects.find((o) => o.id === manipId.current);
            manipStartRotation.current = obj ? [...obj.rotation] : [0, 0, 0];
            manipHand.current = singleSide;
            prevInterHandVec.current = null;
          }
          const deltaRoll = angleDiff(singleHand.roll, manipStartRoll.current);
          if (Math.abs(deltaRoll) > ROTATE_DEADZONE) {
            const camForward = camera.getWorldDirection(new THREE.Vector3()).normalize();
            const twist = new THREE.Quaternion().setFromAxisAngle(camForward, deltaRoll);
            const baseQuat = new THREE.Quaternion().setFromEuler(new THREE.Euler(...manipStartRotation.current));
            const nextQuat = twist.multiply(baseQuat);
            const nextEuler = new THREE.Euler().setFromQuaternion(nextQuat);
            const rotation: [number, number, number] = [nextEuler.x, nextEuler.y, nextEuler.z];
            editor.updateTransform(manipId.current, { rotation });
            setBodyRotation(manipId.current, rotation);
          }
        } else {
          manipId.current = null;
          manipHand.current = null;
          prevInterHandVec.current = null;
        }
      } catch {
        // Physics/store stubs may still throw; fusion loop stays alive regardless.
      }
    } else if (interactionMode === "scale") {
      // Two-hand pinch-distance scale (pinch-to-zoom): the object's scale tracks the ratio of
      // the current inter-hand screen distance to the distance at the moment BOTH hands started
      // pinching together, so it's directly proportional to hand separation — immediate, not
      // laggy like a depth proxy. Moving hands apart grows the object, together shrinks it.
      // Stops the instant either hand un-pinches, and re-snapshots on the next two-hand pinch.
      try {
        const leftPinch = hands.left?.isPinching ?? false;
        const rightPinch = hands.right?.isPinching ?? false;
        const twoHandPinch = leftPinch && rightPinch && !!hands.left && !!hands.right;

        if (!manipId.current) {
          if (targetId && twoHandPinch && hands.left && hands.right) {
            pin(targetId);
            manipId.current = targetId;
            scaleInitialDist.current = Math.hypot(
              hands.right.cursorPx.x - hands.left.cursorPx.x,
              hands.right.cursorPx.y - hands.left.cursorPx.y,
            );
            const obj = editor.objects.find((o) => o.id === targetId);
            scaleInitialScale.current = obj ? [...obj.scale] : [1, 1, 1];
          }
        } else if (!twoHandPinch) {
          manipId.current = null;
        } else if (hands.left && hands.right) {
          const currDist = Math.hypot(
            hands.right.cursorPx.x - hands.left.cursorPx.x,
            hands.right.cursorPx.y - hands.left.cursorPx.y,
          );
          const factor = THREE.MathUtils.clamp(
            currDist / Math.max(scaleInitialDist.current, 1e-6),
            SCALE_MIN,
            SCALE_MAX,
          );
          const [sx, sy, sz] = scaleInitialScale.current;
          editor.updateTransform(manipId.current, { scale: [sx * factor, sy * factor, sz * factor] });
        }
      } catch {
        // Store stubs may still throw; fusion loop stays alive regardless.
      }
    } else if (interactionMode === "delete") {
      if (hand?.isPinching && !wasPinching.current && hoveredObjectId) {
        editor.select(hoveredObjectId);
        editor.deleteSelected();
      }
    }
    wasPinching.current = hand?.isPinching ?? false;

    setFrame((prev) => ({
      position: hitWorld ? [hitWorld.x, hitWorld.y, hitWorld.z] : prev.position,
      force,
      mode: interactionMode,
      hasHit,
    }));

    useFusionStatus.setState({
      interactionMode,
      force,
      calibrated,
      connectionStatus: emg.getConnectionStatus(),
      hasHit,
      hoveredObjectId,
      heldObjectId: heldId.current,
      pinProgress,
      pinningId,
    });
  });

  return frame;
}
