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

/** Two-hand pinch-distance dolly: zooms via the controls' native `dollyIn`, positive = zoom in. */
export function orbitDolly(delta: number): void {
  const ctrl = getOrbitControls();
  if (!ctrl) return;
  const zoomFactor = Math.exp(delta * 0.5);
  ctrl.dollyIn(zoomFactor);
  ctrl.update();
}
