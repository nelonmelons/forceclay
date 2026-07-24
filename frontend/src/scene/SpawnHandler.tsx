/**
 * Spawns a new sculptable clay sphere above the floor on the `S` key (or a
 * `"forceclay:spawn"` window event, for a DOM button outside the Canvas), drops it in under
 * gravity, and selects it.
 * @remarks Must run inside `<Canvas>` (needs `useThree` for the camera). Uses
 * `makeClaySphere(radius, 14)` per the spec's clay-density requirement — `detail` maps to
 * `IcosahedronGeometry` subdivision, and 14 is the resolution sculpting needs (~2.3k verts);
 * detail 4 would be far too coarse to mold. Spawned `"dynamic"` (not `"fixed"`) so the new
 * redesign's default-physics behavior is visible immediately.
 */
import { useEffect } from "react";
import { useThree } from "@react-three/fiber";
import * as THREE from "three";
import { useEditor } from "../store/editor";
import { makeClaySphere } from "../sculpt/geometry";

const SPAWN_DISTANCE = 3;
const SPAWN_HEIGHT = 2.5;
const SPAWN_RADIUS = 0.6;
const SPAWN_DETAIL = 14;
export const SPAWN_EVENT = "forceclay:spawn";

export default function SpawnHandler() {
  const { camera } = useThree();
  const addObject = useEditor((s) => s.addObject);
  const select = useEditor((s) => s.select);

  useEffect(() => {
    const spawn = () => {
      const forward = new THREE.Vector3();
      camera.getWorldDirection(forward);
      const pos = camera.position.clone().add(forward.multiplyScalar(SPAWN_DISTANCE));
      const id = addObject({
        geometry: "custom",
        customGeometry: makeClaySphere(SPAWN_RADIUS, SPAWN_DETAIL),
        physics: "dynamic",
        position: [pos.x, SPAWN_HEIGHT, pos.z],
      });
      select(id);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() === "s" && !e.repeat) spawn();
    };
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener(SPAWN_EVENT, spawn);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener(SPAWN_EVENT, spawn);
    };
  }, [camera, addObject, select]);

  return null;
}
