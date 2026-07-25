/**
 * Demo table: a surface inside the sim with one of every squeezable prop laid out on it.
 *
 * Rendered as plain meshes plus a fixed Rapier collider rather than store objects, so the table
 * itself can never be grabbed, sculpted or deleted — it is scenery, not content. The props on it
 * ARE store objects, because they need to be picked up.
 */
import { useEffect, useRef } from "react";
import { RigidBody, CuboidCollider } from "@react-three/rapier";
import { useEditor } from "../store/editor";
import { FRAGILE_PREFIX } from "./fragileGeometry";
import { PROPS } from "./propCatalog";

/** Table top surface height, world units. */
export const TABLE_Y = 0.9;
const TOP_W = 3.6;
const TOP_D = 1.3;
const TOP_T = 0.09;
const LEG_R = 0.07;
const Z = -0.35;

/** Evenly spaces the props along the table top. */
function slot(i: number, n: number): [number, number, number] {
  const span = TOP_W - 0.7;
  const x = n <= 1 ? 0 : -span / 2 + (span * i) / (n - 1);
  return [x, TABLE_Y + 0.34, Z];
}

/** Spawns one of every prop on the table, once on mount. */
export function useDemoProps() {
  const done = useRef(false);
  useEffect(() => {
    if (done.current) return;
    done.current = true;
    const st = useEditor.getState();
    PROPS.forEach((spec, i) => {
      try {
        st.addObject({
          geometry: "custom",
          customGeometry: spec.geometry(),
          name: `${FRAGILE_PREFIX}${spec.key}`,
          position: slot(i, PROPS.length),
          physics: "dynamic",
          material: spec.material,
        });
      } catch (e) {
        // One bad geometry must not stop the rest of the table being laid out.
        console.warn(`[demo] failed to spawn ${spec.key}`, e);
      }
    });
  }, []);
}

/** The table mesh + collider. Mount inside `<Physics>`. */
export default function DemoTable() {
  const legs: [number, number][] = [
    [TOP_W / 2 - 0.16, TOP_D / 2 - 0.16],
    [-(TOP_W / 2 - 0.16), TOP_D / 2 - 0.16],
    [TOP_W / 2 - 0.16, -(TOP_D / 2 - 0.16)],
    [-(TOP_W / 2 - 0.16), -(TOP_D / 2 - 0.16)],
  ];
  return (
    <>
      <RigidBody type="fixed" colliders={false} position={[0, TABLE_Y, Z]}>
        <CuboidCollider args={[TOP_W / 2, TOP_T / 2, TOP_D / 2]} restitution={0.15} friction={1} />
        <mesh castShadow={false} receiveShadow={false}>
          <boxGeometry args={[TOP_W, TOP_T, TOP_D]} />
          <meshStandardMaterial color="#d9c7a8" roughness={0.75} metalness={0.02} />
        </mesh>
      </RigidBody>
      {legs.map(([x, z], i) => (
        <mesh key={i} position={[x, TABLE_Y / 2, Z + z]}>
          <cylinderGeometry args={[LEG_R, LEG_R, TABLE_Y, 10]} />
          <meshStandardMaterial color="#b09a78" roughness={0.8} metalness={0.02} />
        </mesh>
      ))}
    </>
  );
}
