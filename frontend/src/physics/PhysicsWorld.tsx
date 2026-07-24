/**
 * Wraps the scene in Rapier `<Physics>` and exposes grab/release/squash actions on scene
 * objects (Task E).
 * @remarks Sculpting objects stay `physics:"fixed"` (no body); dropped objects become
 * `RigidBody` with a convex-hull collider — never the live concave sculpt mesh (perf).
 */
import { Physics } from "@react-three/rapier";
import type { ReactNode } from "react";

export interface PhysicsWorldProps {
  children?: ReactNode;
}

/** Root Rapier physics provider for the scene. */
export default function PhysicsWorld({ children }: PhysicsWorldProps) {
  return <Physics>{children}</Physics>;
}

/** Sets object `id` kinematic and makes it follow `handWorldPos` each frame. */
export function grab(_id: string, _handWorldPos: [number, number, number]): void {
  throw new Error("notImplemented: grab");
}

/** Releases object `id` to dynamic gravity, inheriting `velocity` for a throw. */
export function release(_id: string, _velocity: [number, number, number]): void {
  throw new Error("notImplemented: release");
}

/** Applies a squash-and-stretch scale to object `id` proportional to `force`; eases back on release. */
export function squash(_id: string, _force: number): void {
  throw new Error("notImplemented: squash");
}
