/**
 * Per-frame fusion controller: reads `HandState` + `EmgMessage`, raycasts camera->cursor to
 * a surface hit, and dispatches behavior by `interactionMode` (the store's single source of
 * truth for what interaction currently means).
 * @remarks Branching is keyed off `useEditor`'s `interactionMode`, not an EMG classifier or a
 * hand-pose fallback:
 * - `"warp"` is the ONLY mode that reads/uses EMG `force` — it sculpts (press-in) the hovered
 *   object and pins it on first deform so it doesn't fall while being worked.
 * - `"select"`/`"physics"` grab/carry via `hand.isPinching` (no force gating) with hold-to-pin:
 *   holding the carry point within a small radius for ~1.5s auto-pins the object in place.
 * - `"delete"` hover-highlights the object under the cursor (via `useFusionStatus`) and
 *   removes it on pinch.
 * - `"move"`/`"rotate"`/`"scale"` are gizmo-owned; this hook does not grab in those modes.
 * - `"edit"` is vertex-handle-owned (`VertexEditHandles`); this hook does not grab/sculpt.
 *
 * Must be called from a component mounted *inside* the r3f `<Canvas>` (it uses `useFrame`/
 * `useThree`) and inside `VisionSocketProvider` + `EmgSocketProvider`. This is also the single
 * call site for `useSkeleton` (see `hands/useSkeleton.ts`'s module-level EMA/pinch-history
 * state) — the computed `HandState` is mirrored into `control/useHandState.ts` each frame so
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
import { useSkeleton } from "../hands/useSkeleton";
import { useEditor } from "../store/editor";
import { applyBrush } from "../sculpt/brush";
import { grab, release, pin } from "../physics/PhysicsWorld";
import { BRUSH_RADIUS } from "../contracts";
import { useFusionStatus } from "./fusionStatus";
import { useHandState } from "./useHandState";
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
/** Sculpt writes are throttled to roughly this many Hz to keep BVH rebuilds affordable. */
const SCULPT_HZ = 30;
/** Warm emissive color clay ramps toward as sculpt force rises. */
const HOT_COLOR = new THREE.Color("#ff6a1f");
const COLD_COLOR = new THREE.Color("#000000");

/** Wraps an angle delta into (-pi, pi] so a 2pi wraparound doesn't register as a huge jump. */
function normalizeAngleDelta(delta: number): number {
  let d = delta % (2 * Math.PI);
  if (d > Math.PI) d -= 2 * Math.PI;
  if (d < -Math.PI) d += 2 * Math.PI;
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
  const lastHandWorldPos = useRef(new THREE.Vector3());
  const lastSculptTime = useRef(0);
  const holdStartPos = useRef<THREE.Vector3 | null>(null);
  const holdStartTime = useRef(0);
  const wasPinching = useRef(false);
  /** Baseline hand roll angle at grab-start, for frame-to-frame delta-rotation while carrying. */
  const lastHandAngle = useRef<number | null>(null);

  // `useSkeleton` is a hook and must be called at the top level on every render, not from
  // inside the `useFrame` callback. Vision arrives at camera-capture cadence (well under
  // 60fps), so a modest re-render tick is enough to keep the derived `HandState` fresh; the
  // raycast/physics/sculpt work below still runs every animation frame via `useFrame`.
  const [, tick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => tick((t) => (t + 1) % 1_000_000), 33);
    return () => clearInterval(id);
  }, []);
  const hand = useSkeleton(vision.getData()?.hands);
  useEffect(() => {
    useHandState.setState(hand);
  }, [hand]);

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

    if (hand.present) {
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
        lastHandAngle.current = null;
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
      try {
        if (!heldId.current) {
          if (hasHit && hitObjectId && hand.isPinching) {
            grab(hitObjectId, [handWorldPos.x, handWorldPos.y, handWorldPos.z]);
            heldId.current = hitObjectId;
            lastHandWorldPos.current.copy(handWorldPos);
            holdStartPos.current = null;
            lastHandAngle.current = hand.handAngle;
          }
        } else {
          const held = heldId.current;
          if (!hand.isPinching) {
            const velocity = handWorldPos.clone().sub(lastHandWorldPos.current);
            release(held, [velocity.x, velocity.y, velocity.z]);
            heldId.current = null;
            holdStartPos.current = null;
            lastHandAngle.current = null;
          } else {
            grab(held, [handWorldPos.x, handWorldPos.y, handWorldPos.z]);
            lastHandWorldPos.current.copy(handWorldPos);

            // Twist-to-rotate: apply the hand's frame-to-frame roll delta about the camera's
            // view axis, composed onto the object's current orientation (fine rotation while
            // carrying — additive to the drag-plane translation above, not a replacement).
            if (lastHandAngle.current !== null) {
              const deltaAngle = normalizeAngleDelta(hand.handAngle - lastHandAngle.current);
              const heldObj = editor.objects.find((o) => o.id === held);
              if (heldObj && deltaAngle !== 0) {
                const camForward = new THREE.Vector3();
                camera.getWorldDirection(camForward);
                const deltaQuat = new THREE.Quaternion().setFromAxisAngle(camForward, deltaAngle);
                const currentQuat = new THREE.Quaternion().setFromEuler(new THREE.Euler(...heldObj.rotation));
                const nextQuat = deltaQuat.multiply(currentQuat);
                const nextEuler = new THREE.Euler().setFromQuaternion(nextQuat);
                editor.updateTransform(held, { rotation: [nextEuler.x, nextEuler.y, nextEuler.z] });
              }
            }
            lastHandAngle.current = hand.handAngle;

            const now = state.clock.getElapsedTime();
            if (!holdStartPos.current) {
              holdStartPos.current = handWorldPos.clone();
              holdStartTime.current = now;
            } else if (holdStartPos.current.distanceTo(handWorldPos) > PIN_RADIUS) {
              holdStartPos.current = handWorldPos.clone();
              holdStartTime.current = now;
            } else {
              const progress = Math.min((now - holdStartTime.current) / PIN_DURATION, 1);
              pinProgress = progress;
              pinningId = held;
              if (progress >= 1) {
                pin(held);
                heldId.current = null;
                holdStartPos.current = null;
                lastHandAngle.current = null;
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
      if (hand.isPinching && !wasPinching.current && hoveredObjectId) {
        editor.select(hoveredObjectId);
        editor.deleteSelected();
      }
    }
    wasPinching.current = hand.isPinching;

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
