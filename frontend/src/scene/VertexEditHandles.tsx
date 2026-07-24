/**
 * Draggable vertex handles for the selected object's `customGeometry`, active in "edit"
 * `interactionMode`.
 * @remarks Mirrors ShapeShift's vertex-marker technique: vertices sharing a position (rounded
 * to `GROUP_PRECISION` decimals) are grouped into one draggable handle so dragging it rewrites
 * every co-located vertex index, not just one. Supports mouse drag (camera-facing drag plane,
 * window-level pointermove/up so the drag survives leaving the small handle mesh) and
 * hand-pinch drag (via the shared `useHandState` store — see that module's header for why
 * `useSkeleton` isn't called here directly). Commits through `updateGeometry` (with empty
 * `normals` so `ClayObject.buildGeometry` recomputes them) so undo/redo stays intact. Disables
 * mouse `OrbitControls` for the duration of a drag (via `orbitControls.ts`'s "vertex" reason,
 * covering both the mouse and hand-pinch drag paths) so camera orbit doesn't fight a drag.
 */
import { useEffect, useMemo, useRef } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import type { ThreeEvent } from "@react-three/fiber";
import * as THREE from "three";
import { useEditor } from "../store/editor";
import { useHandState } from "../control/useHandState";
import { pin } from "../physics/PhysicsWorld";
import { setOrbitDisabled } from "./orbitControls";
import type { SerializableGeometry } from "../types";

const GROUP_PRECISION = 4;
const HANDLE_RADIUS = 0.035;
/** World-unit distance from the hand's ray within which a pinch is considered "on" a handle. */
const HAND_GRAB_RADIUS = 0.12;

interface PositionGroup {
  key: string;
  position: [number, number, number];
  indices: number[];
}

/** Groups vertex indices that share a (rounded) position, so one handle drives every co-located vertex. */
function buildGroups(geo: SerializableGeometry): PositionGroup[] {
  const map = new Map<string, PositionGroup>();
  const count = geo.positions.length / 3;
  for (let i = 0; i < count; i++) {
    const x = geo.positions[i * 3];
    const y = geo.positions[i * 3 + 1];
    const z = geo.positions[i * 3 + 2];
    const key = `${x.toFixed(GROUP_PRECISION)}|${y.toFixed(GROUP_PRECISION)}|${z.toFixed(GROUP_PRECISION)}`;
    let group = map.get(key);
    if (!group) {
      group = { key, position: [x, y, z], indices: [] };
      map.set(key, group);
    }
    group.indices.push(i);
  }
  return [...map.values()];
}

export default function VertexEditHandles() {
  const interactionMode = useEditor((s) => s.interactionMode);
  const selectedId = useEditor((s) => s.selectedId);
  const objects = useEditor((s) => s.objects);
  const updateGeometry = useEditor((s) => s.updateGeometry);
  const { camera, gl } = useThree();

  const object = objects.find((o) => o.id === selectedId);

  const groups = useMemo(() => {
    if (!object?.customGeometry) return [] as PositionGroup[];
    return buildGroups(object.customGeometry);
  }, [object?.customGeometry]);

  const groupRef = useRef<THREE.Group>(null);
  const dragGroupKey = useRef<string | null>(null);
  const dragOffset = useRef(new THREE.Vector3());
  const dragPlane = useRef(new THREE.Plane());
  const draggingViaHand = useRef(false);
  const pinnedThisSession = useRef(false);
  const raycaster = useRef(new THREE.Raycaster()).current;

  useEffect(() => {
    pinnedThisSession.current = false;
    dragGroupKey.current = null;
    draggingViaHand.current = false;
  }, [selectedId]);

  // Clear the disable reason on unmount so switching selection/mode mid-drag can't leave
  // orbit stuck off.
  useEffect(() => () => setOrbitDisabled("vertex", false), []);

  function beginPin() {
    if (object && object.physics !== "fixed" && !pinnedThisSession.current) {
      pin(object.id);
      pinnedThisSession.current = true;
    }
  }

  function commitDrag(worldPoint: THREE.Vector3) {
    if (!object?.customGeometry || !dragGroupKey.current || !groupRef.current) return;
    const group = groups.find((g) => g.key === dragGroupKey.current);
    if (!group) return;
    const local = groupRef.current.worldToLocal(worldPoint.clone());
    const positions = object.customGeometry.positions.slice();
    for (const idx of group.indices) {
      positions[idx * 3] = local.x;
      positions[idx * 3 + 1] = local.y;
      positions[idx * 3 + 2] = local.z;
    }
    // Empty normals forces `buildGeometry` to recompute them after this structural edit.
    updateGeometry(object.id, { positions, indices: object.customGeometry.indices, normals: [] });
  }

  function startDrag(group: PositionGroup, ray: THREE.Ray) {
    if (!groupRef.current) return;
    beginPin();
    setOrbitDisabled("vertex", true);
    dragGroupKey.current = group.key;
    const camDir = new THREE.Vector3();
    camera.getWorldDirection(camDir);
    const worldPos = groupRef.current.localToWorld(new THREE.Vector3(...group.position));
    dragPlane.current.setFromNormalAndCoplanarPoint(camDir, worldPos);
    const intersection = new THREE.Vector3();
    if (ray.intersectPlane(dragPlane.current, intersection)) {
      dragOffset.current.copy(worldPos).sub(intersection);
    } else {
      dragOffset.current.set(0, 0, 0);
    }
  }

  function onHandlePointerDown(e: ThreeEvent<PointerEvent>, group: PositionGroup) {
    e.stopPropagation();
    draggingViaHand.current = false;
    startDrag(group, e.ray);

    const onMove = (ev: PointerEvent) => {
      const rect = gl.domElement.getBoundingClientRect();
      const ndc = new THREE.Vector2(
        ((ev.clientX - rect.left) / rect.width) * 2 - 1,
        -(((ev.clientY - rect.top) / rect.height) * 2 - 1),
      );
      raycaster.setFromCamera(ndc, camera);
      const intersection = new THREE.Vector3();
      if (raycaster.ray.intersectPlane(dragPlane.current, intersection)) {
        intersection.add(dragOffset.current);
        commitDrag(intersection);
      }
    };
    const onUp = () => {
      dragGroupKey.current = null;
      setOrbitDisabled("vertex", false);
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  }

  // Hand-pinch drag: raycast the shared hand cursor against handle world positions each frame.
  useFrame(() => {
    if (interactionMode !== "edit" || !object || !groupRef.current || groups.length === 0) return;
    const hand = useHandState.getState();
    if (!hand.present) {
      if (draggingViaHand.current) {
        dragGroupKey.current = null;
        draggingViaHand.current = false;
        setOrbitDisabled("vertex", false);
      }
      return;
    }

    raycaster.setFromCamera(new THREE.Vector2(hand.cursorNdc.x, hand.cursorNdc.y), camera);

    if (!draggingViaHand.current) {
      if (!hand.isPinching) return;
      let nearest: PositionGroup | null = null;
      let nearestDist = Infinity;
      for (const g of groups) {
        const worldPos = groupRef.current.localToWorld(new THREE.Vector3(...g.position));
        const dist = raycaster.ray.distanceToPoint(worldPos);
        if (dist < nearestDist) {
          nearestDist = dist;
          nearest = g;
        }
      }
      if (nearest && nearestDist < HAND_GRAB_RADIUS) {
        draggingViaHand.current = true;
        startDrag(nearest, raycaster.ray);
      }
    } else {
      if (!hand.isPinching) {
        dragGroupKey.current = null;
        draggingViaHand.current = false;
        setOrbitDisabled("vertex", false);
        return;
      }
      const intersection = new THREE.Vector3();
      if (raycaster.ray.intersectPlane(dragPlane.current, intersection)) {
        intersection.add(dragOffset.current);
        commitDrag(intersection);
      }
    }
  });

  if (interactionMode !== "edit" || !object || !object.customGeometry) return null;

  return (
    <group ref={groupRef} position={object.position} rotation={object.rotation} scale={object.scale}>
      {groups.map((g) => (
        <mesh
          key={g.key}
          position={g.position}
          onPointerDown={(e) => onHandlePointerDown(e, g)}
        >
          <sphereGeometry args={[HANDLE_RADIUS, 8, 8]} />
          <meshStandardMaterial color="#38bdf8" emissive="#38bdf8" emissiveIntensity={0.6} />
        </mesh>
      ))}
    </group>
  );
}
