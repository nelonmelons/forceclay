/**
 * Per-frame fusion controller: reads `TwoHandState` + `EmgMessage`, raycasts camera->cursor to
 * a surface hit, and dispatches behavior by `interactionMode` (the store's single source of
 * truth for what interaction currently means).
 * @remarks Two independent gesture systems run every frame, mirroring ShapeShift exactly:
 * - Camera navigation (always on, in every mode): one hand `isHolding` (thumb-index pinch)
 *   orbit-rotates the camera; both hands `isHolding` pans (from the left hand's cursor delta)
 *   and dollies (from the change in inter-hand distance). See `scene/cameraGestures.ts`.
 * - Object interaction is keyed off `useEditor`'s `interactionMode`, using the *primary* hand
 *   (`hands/useSkeleton.ts`'s `getPrimaryHand` — right hand, falling back to left):
 *   - `"warp"` is the ONLY mode that reads/uses EMG `force` — it sculpts (press-in) the hovered
 *     object and pins it on first deform so it doesn't fall while being worked.
 *   - `"select"`/`"physics"` grab/carry via the primary hand's `isPinching` (all-5-fingertip
 *     cluster; no force gating) with hold-to-pin: holding the carry point within a small radius
 *     for ~1.5s auto-pins the object in place. Objects do NOT rotate with the hand (no
 *     twist-to-rotate — ShapeShift has no such mechanic either).
 *   - `"delete"` hover-highlights the object under the cursor (via `useFusionStatus`) and
 *     removes it on pinch.
 *   - `"move"`/`"rotate"`/`"scale"` are gizmo-owned; this hook does not grab in those modes.
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
import { grab, release, pin, getBodyPosition } from "../physics/PhysicsWorld";
import { BRUSH_RADIUS } from "../contracts";
import { useFusionStatus } from "./fusionStatus";
import { useHandState } from "./useHandState";
import { orbitRotate, orbitPan, orbitDolly } from "../scene/cameraGestures";
import type { InteractionMode } from "../types";

export { useFusionStatus } from "./fusionStatus";

/** Result handed back to the caller each render for driving `HandCursor`. */
export interface FusionFrame {
  position: [number, number, number];
  force: number;
  mode: InteractionMode;
  hasHit: boolean;
}

/** World-space radius the carry point must stay within to keep charging hold-to-pin. */
const PIN_RADIUS = 0.15;
/** Seconds the carry point must stay within `PIN_RADIUS` before auto-pinning. */
const PIN_DURATION = 1.5;
/** Smoothing for the carried object's position (ShapeShift lerps ~0.1; lower = smoother/laggier). */
const CARRY_LERP = 0.2;
/** Hand-size depth → push/pull sensitivity along the view ray while carrying. */
const DEPTH_SENS = 4;
/** Per-frame carry delta → release/throw velocity (units/sec). */
const THROW_GAIN = 40;
/** Sculpt writes are throttled to roughly this many Hz to keep BVH rebuilds affordable. */
const SCULPT_HZ = 30;
/** Warm emissive color clay ramps toward as sculpt force rises. */
const HOT_COLOR = new THREE.Color("#ff6a1f");
const COLD_COLOR = new THREE.Color("#000000");

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
  const lastSculptTime = useRef(0);
  const holdStartPos = useRef<THREE.Vector3 | null>(null);
  const holdStartTime = useRef(0);
  const wasPinching = useRef(false);
  /** ShapeShift-style carry state: camera-facing drag plane, grab offset, and smoothed carry point. */
  const dragPlane = useRef(new THREE.Plane());
  const dragOffset = useRef(new THREE.Vector3());
  const initialHandDepth = useRef(0);
  const carryPos = useRef(new THREE.Vector3());
  const lastCarryPos = useRef(new THREE.Vector3());
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

    // Camera navigation runs in every mode, independent of the mode-branch below: one hand
    // holding (thumb-index pinch, stable ~50ms) orbits the camera; both hands holding pans
    // (from the left hand's delta) and dollies (from the change in inter-hand distance).
    // Mirrors ShapeShift's HolohandsOverlay per-frame wiring exactly.
    const leftHold = hands.left?.isHolding ?? false;
    const rightHold = hands.right?.isHolding ?? false;
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

    // Approximate the hand's world position as the ray hit (fallback: a point in front of camera).
    const handWorldPos = hitWorld ?? camera.position.clone().add(new THREE.Vector3(0, 0, -2));
    const hoveredObjectId = hasHit ? hitObjectId : null;
    let pinProgress = 0;
    let pinningId: string | null = null;

    if (interactionMode !== "select" && interactionMode !== "physics" && heldId.current) {
      // Left a grab-capable mode while still holding something — drop it where it is.
      try {
        release(heldId.current, [0, 0, 0]);
      } catch {
        // ignore
      } finally {
        heldId.current = null;
        holdStartPos.current = null;
      }
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
          if (hasHit && hitObjectId && hand && hand.isPinching) {
            const bp = getBodyPosition(hitObjectId);
            const objWorld = bp ? new THREE.Vector3(bp[0], bp[1], bp[2]) : (hitWorld ?? handWorldPos).clone();
            const camForward = camera.getWorldDirection(new THREE.Vector3());
            dragPlane.current.setFromNormalAndCoplanarPoint(camForward, objWorld);
            raycaster.setFromCamera(new THREE.Vector2(hand.cursorNdc.x, hand.cursorNdc.y), camera);
            const planePt = new THREE.Vector3();
            if (raycaster.ray.intersectPlane(dragPlane.current, planePt)) {
              dragOffset.current.copy(objWorld).sub(planePt);
            } else {
              dragOffset.current.set(0, 0, 0);
            }
            initialHandDepth.current = hand.depthProxy;
            carryPos.current.copy(objWorld);
            lastCarryPos.current.copy(objWorld);
            grab(hitObjectId, [objWorld.x, objWorld.y, objWorld.z]);
            heldId.current = hitObjectId;
            holdStartPos.current = null;
          }
        } else {
          const held = heldId.current;
          if (!hand || !hand.isPinching) {
            const velocity = carryPos.current.clone().sub(lastCarryPos.current).multiplyScalar(THROW_GAIN);
            release(held, [velocity.x, velocity.y, velocity.z]);
            heldId.current = null;
            holdStartPos.current = null;
          } else {
            // Follow the drag plane, smoothed. lastCarryPos is captured before the lerp so the
            // per-frame delta doubles as throw velocity on release.
            raycaster.setFromCamera(new THREE.Vector2(hand.cursorNdc.x, hand.cursorNdc.y), camera);
            const target = new THREE.Vector3();
            if (raycaster.ray.intersectPlane(dragPlane.current, target)) {
              target.add(dragOffset.current);
              const deltaDepth = initialHandDepth.current - hand.depthProxy;
              target.add(raycaster.ray.direction.clone().multiplyScalar(deltaDepth * DEPTH_SENS));
              lastCarryPos.current.copy(carryPos.current);
              carryPos.current.lerp(target, CARRY_LERP);
              grab(held, [carryPos.current.x, carryPos.current.y, carryPos.current.z]);
            }

            // Hold-to-pin, judged on the smoothed carry position.
            const now = state.clock.getElapsedTime();
            if (!holdStartPos.current) {
              holdStartPos.current = carryPos.current.clone();
              holdStartTime.current = now;
            } else if (holdStartPos.current.distanceTo(carryPos.current) > PIN_RADIUS) {
              holdStartPos.current = carryPos.current.clone();
              holdStartTime.current = now;
            } else {
              const progress = Math.min((now - holdStartTime.current) / PIN_DURATION, 1);
              pinProgress = progress;
              pinningId = held;
              if (progress >= 1) {
                pin(held);
                heldId.current = null;
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
