/**
 * Mouse-driven transform gizmo for the selected object, active in "move"/"rotate"/"scale"
 * `interactionMode`.
 * @remarks Attaches drei's `TransformControls` to an invisible proxy `<group>` (not the
 * physics-owned mesh, so `PhysicsWorld` stays the sole render path for `SceneObject`s) whose
 * transform mirrors the selected object's store state. Dragging updates the store via
 * `updateTransform`, which `PhysicsWorld`'s `<RigidBody position/rotation>` props pick up
 * automatically (`@react-three/rapier` re-applies transform props to the underlying Rapier
 * body even when it's `Fixed`), so no direct Rapier calls are needed here. Pins the object on
 * first interaction so physics doesn't fight the manual edit. Disables mouse `OrbitControls`
 * for the duration of a drag (via `orbitControls.ts`'s "gizmo" reason) so orbiting the camera
 * doesn't fight dragging the gizmo handles.
 */
import { useEffect, useRef, useState } from "react";
import { TransformControls } from "@react-three/drei";
import * as THREE from "three";
import { useEditor } from "../store/editor";
import { pin } from "../physics/PhysicsWorld";
import { setOrbitDisabled } from "./orbitControls";
import type { InteractionMode } from "../types";

const MODE_MAP: Partial<Record<InteractionMode, "translate" | "rotate" | "scale">> = {
  move: "translate",
  rotate: "rotate",
  scale: "scale",
};

export default function TransformGizmo() {
  const interactionMode = useEditor((s) => s.interactionMode);
  const selectedId = useEditor((s) => s.selectedId);
  const objects = useEditor((s) => s.objects);
  const updateTransform = useEditor((s) => s.updateTransform);
  const proxyRef = useRef<THREE.Group>(null);
  // TransformControls needs a non-null `THREE.Object3D` target; a ref-callback state hand-off
  // sidesteps the `RefObject<Group | null>` vs. `RefObject<Object3D>` type mismatch.
  const [proxyObject, setProxyObject] = useState<THREE.Group | null>(null);
  const pinnedThisSession = useRef(false);

  const object = objects.find((o) => o.id === selectedId);
  const gizmoMode = MODE_MAP[interactionMode];

  useEffect(() => {
    pinnedThisSession.current = false;
  }, [selectedId, interactionMode]);

  // Clear the disable reason on unmount so a mode switch mid-drag can't leave orbit stuck off.
  useEffect(() => () => setOrbitDisabled("gizmo", false), []);

  if (!object || !gizmoMode) return null;

  const handleChange = () => {
    const proxy = proxyRef.current;
    if (!proxy) return;
    if (!pinnedThisSession.current && object.physics !== "fixed") {
      pin(object.id);
      pinnedThisSession.current = true;
    }
    updateTransform(object.id, {
      position: [proxy.position.x, proxy.position.y, proxy.position.z],
      rotation: [proxy.rotation.x, proxy.rotation.y, proxy.rotation.z],
      scale: [proxy.scale.x, proxy.scale.y, proxy.scale.z],
    });
  };

  return (
    <>
      {/* Sibling (not parent) of TransformControls: the gizmo widget must not inherit this
          group's rotation/scale, only sample its world position via the `object` ref. */}
      <group
        key={object.id}
        ref={(g) => {
          proxyRef.current = g;
          setProxyObject(g);
        }}
        position={object.position}
        rotation={object.rotation}
        scale={object.scale}
      />
      {proxyObject && (
        <TransformControls
          object={proxyObject}
          mode={gizmoMode}
          onObjectChange={handleChange}
          onMouseDown={() => setOrbitDisabled("gizmo", true)}
          onMouseUp={() => setOrbitDisabled("gizmo", false)}
        />
      )}
    </>
  );
}
