/**
 * Module-level handle to the shared drei `OrbitControls` instance, so components deep inside
 * `PhysicsWorld` (the transform gizmo, vertex-edit handles) and the fusion loop (hand carry/
 * warp) can disable camera orbit while busy, without prop-drilling a ref through
 * `Viewport` -> `PhysicsWorld` -> `ClayObject`.
 * @remarks Mirrors the module-level registry pattern already used by `physics/PhysicsWorld.tsx`
 * for its grab/squash API. Multiple independent callers can each hold orbit disabled at once
 * (e.g. a hand carry could theoretically overlap a gizmo drag), so reasons are tracked in a
 * set — orbit only re-enables once every reason has cleared.
 */
import type { OrbitControls as OrbitControlsImpl } from "three-stdlib";

let controls: OrbitControlsImpl | null = null;
const disableReasons = new Set<string>();

function applyEnabled(): void {
  if (controls) controls.enabled = disableReasons.size === 0;
}

/** Registers (or clears, on unmount) the shared `OrbitControls` instance. */
export function registerOrbitControls(instance: OrbitControlsImpl | null): void {
  controls = instance;
  applyEnabled();
}

/**
 * Adds or removes a named reason to keep orbit disabled (e.g. "gizmo", "vertex", "hand").
 * Orbit is re-enabled once no reasons remain active.
 */
export function setOrbitDisabled(reason: string, disabled: boolean): void {
  if (disabled) disableReasons.add(reason);
  else disableReasons.delete(reason);
  applyEnabled();
}
