/**
 * ShapeShift-faithful camera navigation: one-hand-holding orbit-rotate, two-hand-holding
 * pan+dolly, driven per-frame by `control/useFusion.ts` off `HandInfo.isHolding`.
 * @remarks Operates directly on the shared drei `OrbitControls` instance (see
 * `scene/orbitControls.ts`) so hand-driven navigation and mouse orbit share one camera/target
 * state and never diverge. Math mirrors ShapeShift's `Viewport.tsx` `orbitRotate`/`orbitPan`/
 * `orbitDolly` exactly (spherical-offset rotate, frustum-scaled pan along camera basis, native
 * `dollyIn` zoom). Runs in every `interactionMode` — camera navigation is always available.
 */
import * as THREE from "three";
import { getOrbitControls } from "./orbitControls";

/** Radians of orbit per a full (dxN=1) normalized cursor-delta sweep. */
const ROTATE_SPEED = Math.PI;
const PHI_EPSILON = 1e-6;

/** One-hand-holding rotate: spherical orbit of the camera around the controls' target. */
export function orbitRotate(dxN: number, dyN: number): void {
  const ctrl = getOrbitControls();
  if (!ctrl) return;
  const camera = ctrl.object;
  const target = ctrl.target;

  const offset = new THREE.Vector3().subVectors(camera.position, target);
  const spherical = new THREE.Spherical().setFromVector3(offset);

  spherical.theta -= dxN * ROTATE_SPEED;
  spherical.phi -= dyN * ROTATE_SPEED;
  spherical.phi = Math.max(PHI_EPSILON, Math.min(Math.PI - PHI_EPSILON, spherical.phi));

  const newOffset = new THREE.Vector3().setFromSpherical(spherical);
  camera.position.copy(new THREE.Vector3().addVectors(target, newOffset));
  camera.lookAt(target);
  ctrl.update();
}

/**
 * Two-hand-holding pan: moves camera + target together along the camera's local X/Y axes,
 * scaled so a full-frame cursor sweep pans one frustum-height at the target's distance.
 */
export function orbitPan(dxN: number, dyN: number): void {
  const ctrl = getOrbitControls();
  if (!ctrl) return;
  const camera = ctrl.object;
  const target = ctrl.target;

  let panX: number;
  let panY: number;
  if ((camera as THREE.PerspectiveCamera).isPerspectiveCamera) {
    const perspective = camera as THREE.PerspectiveCamera;
    const distance = perspective.position.clone().sub(target).length();
    const halfFovY = (perspective.fov * Math.PI) / 180 / 2;
    const heightAtDistance = 2 * distance * Math.tan(halfFovY);
    panX = -dxN * heightAtDistance;
    panY = dyN * heightAtDistance;
  } else if ((camera as THREE.OrthographicCamera).isOrthographicCamera) {
    const ortho = camera as THREE.OrthographicCamera;
    const width = (ortho.right - ortho.left) / ortho.zoom;
    const height = (ortho.top - ortho.bottom) / ortho.zoom;
    panX = -dxN * width;
    panY = dyN * height;
  } else {
    const fallbackScale = 10;
    panX = -dxN * fallbackScale;
    panY = dyN * fallbackScale;
  }

  const xAxis = new THREE.Vector3();
  const yAxis = new THREE.Vector3();
  const zAxis = new THREE.Vector3();
  camera.matrix.extractBasis(xAxis, yAxis, zAxis);
  const panOffset = new THREE.Vector3().add(xAxis.multiplyScalar(panX)).add(yAxis.multiplyScalar(panY));
  camera.position.add(panOffset);
  target.add(panOffset);
  ctrl.update();
}

/**
 * Soft deadzone: eases motion in from zero instead of gating it.
 *
 * A hard `if (|d| > dz)` gate makes motion POP — the moment the hand crosses the threshold the
 * full magnitude applies, so slow deliberate zooms feel like they snap. Subtracting the deadzone
 * and rescaling keeps the response continuous: still immune to jitter, but a small motion now
 * produces a small movement.
 */
export function softDeadzone(value: number, deadzone: number): number {
  const a = Math.abs(value);
  if (a <= deadzone) return 0;
  return Math.sign(value) * (a - deadzone) / (1 - deadzone);
}

/** Smoothed dolly state. Module-scoped because there is exactly one camera. */
let dollyVel = 0;
/** EMA factor for the zoom rate — lower is smoother and laggier. */
const DOLLY_SMOOTH = 0.35;
/** Max per-frame pinch delta accepted. Bigger jumps are tracking glitches, not intent. */
const DOLLY_CLAMP = 0.08;
/** Camera distance limits, so a zoom cannot end up inside the object or out in the void. */
const MIN_DIST = 1.2;
const MAX_DIST = 22;

/**
 * Two-hand pinch-distance dolly, smoothed and bounded.
 *
 * Three guards the raw version lacked: the incoming delta is clamped so a landmark jump (hands
 * re-detected, one hand briefly lost) cannot fling the camera; the rate is EMA-smoothed so the
 * zoom glides instead of stuttering with per-frame hand noise; and the resulting distance is
 * held between MIN_DIST and MAX_DIST so you cannot zoom through the scene or lose it entirely.
 */
export function orbitDolly(delta: number): void {
  const ctrl = getOrbitControls();
  if (!ctrl) return;
  const clamped = Math.max(-DOLLY_CLAMP, Math.min(DOLLY_CLAMP, delta));
  dollyVel = dollyVel * (1 - DOLLY_SMOOTH) + clamped * DOLLY_SMOOTH;
  if (Math.abs(dollyVel) < 1e-5) return;

  const cam = ctrl.object as THREE.Camera & { position: THREE.Vector3 };
  const target = ctrl.target as THREE.Vector3;
  const dist = cam.position.distanceTo(target);
  const next = dist / Math.exp(dollyVel * 1.6);
  if ((next < MIN_DIST && dollyVel > 0) || (next > MAX_DIST && dollyVel < 0)) {
    dollyVel = 0;
    return;
  }
  ctrl.dollyIn(Math.exp(dollyVel * 1.6));
  ctrl.update();
}

/** Clears smoothing state so a new gesture does not inherit the last one's momentum. */
export function resetDolly(): void {
  dollyVel = 0;
}
