/**
 * Demo table: a physical surface in the sim with one of every squeezable prop preloaded on it,
 * ready to grab.
 *
 * The table is a single fixed RigidBody with an explicit CuboidCollider for the top only. Two
 * things caused a Canvas crash the first time round and are deliberately avoided here:
 *
 *  - No mesh children inside the RigidBody. @react-three/rapier inspects children to build
 *    colliders, and a child mesh alongside an explicit collider was enough to upset it. The
 *    visible top is a sibling mesh outside the body, so geometry and physics stay independent.
 *  - Legs are decoration only, with no collider at all. Four extra colliders bought nothing --
 *    props rest on the top surface, never on a leg.
 */
import { useEffect, useRef } from "react";
import { RigidBody, CuboidCollider } from "@react-three/rapier";
import { useEditor } from "../store/editor";
import { FRAGILE_PREFIX } from "./fragileGeometry.ts";
import { PROPS } from "./propCatalog.ts";

/** Height of the table top surface, world units. */
export const TABLE_Y = 0.85;
const TOP_W = 3.4;
const TOP_D = 1.2;
const TOP_T = 0.1;
const Z = -0.3;
/** Clearance above the top so a prop settles onto the surface instead of spawning inside it. */
const REST_CLEARANCE = 0.3;

/** Evenly spaces the props across the table top. */
function slot(i: number, n: number): [number, number, number] {
  const span = TOP_W - 0.8;
  const x = n <= 1 ? 0 : -span / 2 + (span * i) / (n - 1);
  return [x, TABLE_Y + TOP_T / 2 + REST_CLEARANCE, Z];
}

/**
 * Preloads one of every prop onto the table, once.
 *
 * Deferred a tick: Rapier's world is created by <Physics> on mount, and adding bodies in the same
 * commit races that setup. Each prop is also built inside its own try so one bad geometry cannot
 * stop the rest of the table being laid out.
 */
export function useDemoProps() {
  const done = useRef(false);
  useEffect(() => {
    if (done.current) return;
    done.current = true;
    const t = setTimeout(() => {
      const st = useEditor.getState();
      const existing = new Set(st.objects.map((o) => o.name));
      PROPS.forEach((spec, i) => {
        const name = `${FRAGILE_PREFIX}${spec.key}`;
        if (existing.has(name)) return;
        try {
          st.addObject({
            geometry: "custom",
            customGeometry: spec.geometry(),
            name,
            position: slot(i, PROPS.length),
            physics: "dynamic",
            material: spec.material,
          });
        } catch (e) {
          console.warn(`[demo] failed to preload ${spec.key}`, e);
        }
      });
    }, 400);
    return () => clearTimeout(t);
  }, []);
}

/** The table. Mount inside <Physics>. */
export default function DemoTable() {
  return (
    <group>
      {/* Physics: top surface only, no mesh children. */}
      <RigidBody type="fixed" colliders={false} position={[0, TABLE_Y, Z]}>
        <CuboidCollider args={[TOP_W / 2, TOP_T / 2, TOP_D / 2]} restitution={0.1} friction={1} />
      </RigidBody>
      {/* Visuals: siblings outside the body, so they never influence collider generation. */}
      <mesh position={[0, TABLE_Y, Z]}>
        <boxGeometry args={[TOP_W, TOP_T, TOP_D]} />
        <meshStandardMaterial color="#d9c7a8" roughness={0.75} metalness={0.02} />
      </mesh>
      {([[1, 1], [-1, 1], [1, -1], [-1, -1]] as [number, number][]).map(([sx, sz], i) => (
        <mesh key={i} position={[sx * (TOP_W / 2 - 0.18), TABLE_Y / 2, Z + sz * (TOP_D / 2 - 0.18)]}>
          <cylinderGeometry args={[0.07, 0.07, TABLE_Y, 10]} />
          <meshStandardMaterial color="#b09a78" roughness={0.8} metalness={0.02} />
        </mesh>
      ))}
    </group>
  );
}
