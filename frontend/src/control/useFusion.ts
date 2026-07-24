/**
 * Per-frame fusion controller: reads `HandState` + `EmgMessage`, raycasts camera->cursor to
 * a surface hit, and dispatches sculpt/grab/smooth actions by mode (Task F).
 * @remarks Camera-pose fallback when no confident LDA `EmgMessage.mode` is present:
 * open=sculpt, pinch=grab, otherwise=smooth. Grab uses `GRAB_FORCE_ON`/`GRAB_FORCE_OFF`
 * hysteresis; squash fires when a force spike happens while an object is held.
 *
 * Must be called from a component mounted *inside* the r3f `<Canvas>` (it uses `useFrame`/
 * `useThree`) and inside `VisionSocketProvider` + `EmgSocketProvider`. This module owns a
 * tiny zustand store (`useFusionStatus`) so DOM overlays (`ForceHUD`, `CalibrationPanel`)
 * outside the Canvas can read the live mode/force without prop drilling.
 *
 * Raycast hit -> `SceneObject` id resolution assumes `ClayObject` (Task C) stamps
 * `mesh.userData.objectId` on the meshes it renders; this walks up the ancestor chain to be
 * resilient to wrapper groups, and simply no-ops (no sculpt/grab) if nothing is tagged.
 */
import { useEffect, useRef, useState } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import * as THREE from "three";
import { create } from "zustand";
import { useVisionSocket } from "../providers/VisionSocket";
import { useEmgSocket } from "../providers/EmgSocket";
import { useSkeleton } from "../hands/useSkeleton";
import { useEditor } from "../store/editor";
import { applyBrush } from "../sculpt/brush";
import { grab, release, squash } from "../physics/PhysicsWorld";
import { GRAB_FORCE_ON, GRAB_FORCE_OFF, BRUSH_RADIUS } from "../contracts";

/** Resolved fusion mode for a given frame (LDA mode when present, else camera-pose fallback). */
export type FusionMode = "sculpt" | "grab" | "smooth" | "spawn" | "idle";

/** Live fusion status exposed to DOM overlays outside the Canvas. */
export interface FusionStatus {
  mode: FusionMode;
  force: number;
  calibrated: boolean;
  connectionStatus: "connecting" | "connected" | "disconnected";
  hasHit: boolean;
  heldObjectId: string | null;
}

/** Zustand store mirroring the latest fusion status; written by `useFusion`, read by UI. */
export const useFusionStatus = create<FusionStatus>(() => ({
  mode: "idle",
  force: 0,
  calibrated: false,
  connectionStatus: "disconnected",
  hasHit: false,
  heldObjectId: null,
}));

/** Result handed back to the caller each render for driving `HandCursor`. */
export interface FusionFrame {
  position: [number, number, number];
  force: number;
  mode: FusionMode;
  hasHit: boolean;
}

/** Force spike (while holding) above which a squash-and-stretch pulse fires. */
const SQUASH_FORCE = 0.85;
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

/** Picks the active mode: trust the EMG classifier when present, else fall back to hand pose. */
function decideMode(emgMode: FusionMode | undefined, handPresent: boolean, isPinching: boolean, isOpen: boolean): FusionMode {
  if (emgMode) return emgMode;
  if (!handPresent) return "idle";
  if (isPinching) return "grab";
  if (isOpen) return "sculpt";
  return "smooth";
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
  const [frame, setFrame] = useState<FusionFrame>({ position: [0, 0, 0], force: 0, mode: "idle", hasHit: false });
  const heldId = useRef<string | null>(null);
  const lastHandWorldPos = useRef(new THREE.Vector3());
  const lastSculptTime = useRef(0);

  // `useSkeleton` is a hook (Task C) and must be called at the top level on every render, not
  // from inside the `useFrame` callback. Vision arrives at camera-capture cadence (well under
  // 60fps), so a modest re-render tick is enough to keep the derived `HandState` fresh; the
  // raycast/physics/sculpt work below still runs every animation frame via `useFrame`.
  const [, tick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => tick((t) => (t + 1) % 1_000_000), 33);
    return () => clearInterval(id);
  }, []);
  const hand = useSkeleton(vision.getData()?.hands);

  useFrame((state) => {
    const emgData = emg.getData();
    const force = emgData?.force ?? 0;
    const calibrated = emgData?.calibrated ?? false;

    const mode = decideMode(emgData?.mode, hand.present, hand.isPinching, hand.isOpen);

    let hasHit = false;
    let hitWorld: THREE.Vector3 | null = null;
    let hitObjectId: string | null = null;
    let hitLocal: [number, number, number] = [0, 0, 0];
    let normalLocal: [number, number, number] = [0, 0, 1];
    let hitMesh: THREE.Object3D | null = null;

    if (hand.present) {
      try {
        raycaster.setFromCamera(new THREE.Vector2(hand.cursorNdc.x, hand.cursorNdc.y), camera);
        const hits = raycaster.intersectObjects(scene.children, true);
        const first = hits.find((h) => h.face);
        if (first && first.face) {
          hasHit = true;
          hitWorld = first.point.clone();
          hitMesh = first.object;
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

    if (mode === "sculpt" || mode === "smooth") {
      const now = state.clock.getElapsedTime();
      const dueSculpt = now - lastSculptTime.current >= 1 / SCULPT_HZ;
      if (hasHit && hitObjectId && force > 0 && dueSculpt) {
        const obj = editor.objects.find((o) => o.id === hitObjectId);
        if (obj?.geometry === "custom" && obj.customGeometry) {
          try {
            const dir: 1 | -1 = mode === "smooth" ? 1 : -1;
            const nextGeo = applyBrush(obj.customGeometry, hitLocal, normalLocal, BRUSH_RADIUS, force, dir);
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
    } else if (mode === "grab") {
      try {
        if (!heldId.current) {
          if (hasHit && hitObjectId && force >= GRAB_FORCE_ON) {
            grab(hitObjectId, [handWorldPos.x, handWorldPos.y, handWorldPos.z]);
            heldId.current = hitObjectId;
            lastHandWorldPos.current.copy(handWorldPos);
          }
        } else {
          const held = heldId.current;
          if (force <= GRAB_FORCE_OFF) {
            const velocity = handWorldPos.clone().sub(lastHandWorldPos.current);
            release(held, [velocity.x, velocity.y, velocity.z]);
            heldId.current = null;
          } else if (force >= SQUASH_FORCE) {
            squash(held, force);
            lastHandWorldPos.current.copy(handWorldPos);
          } else {
            grab(held, [handWorldPos.x, handWorldPos.y, handWorldPos.z]);
            lastHandWorldPos.current.copy(handWorldPos);
          }
        }
      } catch {
        // Physics stubs may still throw notImplemented; fusion loop stays alive regardless.
      }
    } else if (heldId.current) {
      // Mode dropped out of "grab" (e.g. classifier switched) while still holding something.
      try {
        release(heldId.current, [0, 0, 0]);
      } catch {
        // ignore
      } finally {
        heldId.current = null;
      }
    }

    void hitMesh; // retained for future stamp/imprint (Task H); referenced to avoid lint noise.

    setFrame((prev) => ({
      position: hitWorld ? [hitWorld.x, hitWorld.y, hitWorld.z] : prev.position,
      force,
      mode,
      hasHit,
    }));

    useFusionStatus.setState({
      mode,
      force,
      calibrated,
      connectionStatus: emg.getConnectionStatus(),
      hasHit,
      heldObjectId: heldId.current,
    });
  });

  return frame;
}
