/**
 * Wraps the scene in Rapier `<Physics>` and exposes an imperative grab/release/squash API
 * (Task E) that a sibling hook (`useFusion`, Task F) can call without prop-drilling.
 * @remarks Rigid bodies and their meshes are kept in module-level registries keyed by
 * `SceneObject.id`, so `grab`/`release`/`squash` (and the `usePhysicsControls()` hook) are
 * plain, stable references importable from anywhere — no context/provider needed. Colliders
 * are Rapier's auto-generated convex hull (`colliders="hull"`) built from each object's
 * *current* rendered geometry, never a re-triangulated concave sculpt mesh, to keep the
 * broad/narrow phase cheap while sculpting.
 */
import { Physics, RigidBody, type RapierRigidBody } from "@react-three/rapier";
import { RigidBodyType } from "@dimforge/rapier3d-compat";
import { useFrame } from "@react-three/fiber";
import { useEffect, useMemo, useRef } from "react";
import type { ReactNode } from "react";
import * as THREE from "three";
import { useEditor } from "../store/editor";
import type { SceneObject } from "../types";

export interface PhysicsWorldProps {
  children?: ReactNode;
}

// ---- Module-level registries (the "no prop-drilling" imperative API surface) ----

const bodies = new Map<string, RapierRigidBody>();
const meshes = new Map<string, THREE.Object3D>();
const baseScales = new Map<string, [number, number, number]>();
/** Ids currently held; frame loop drives the kinematic body toward this world position. */
const grabPoints = new Map<string, THREE.Vector3>();
/** Ids with an active squash effect; value is the last requested (pre-decay) force. */
const squashTargets = new Map<string, number>();
/** Eased current squash force per id, driven toward `squashTargets` each frame. */
const squashCurrent = new Map<string, number>();

const SQUASH_RISE = 0.35; // ease-in rate toward the requested force
const SQUASH_DECAY = 0.88; // per-frame decay of the requested force (creates "ease back" without an explicit un-squash call)
const SQUASH_EPSILON = 0.002; // below this, snap back to rest and stop updating

function registerBody(id: string, body: RapierRigidBody | null): void {
  if (body) bodies.set(id, body);
  else bodies.delete(id);
}

function registerMesh(id: string, mesh: THREE.Object3D | null, baseScale: [number, number, number]): void {
  if (mesh) {
    meshes.set(id, mesh);
    baseScales.set(id, baseScale);
  } else {
    meshes.delete(id);
    baseScales.delete(id);
  }
}

/** Builds a renderable+colliderable `BufferGeometry` for a `SceneObject`'s primitive or custom mesh. */
function buildGeometry(object: SceneObject): THREE.BufferGeometry {
  if (object.geometry === "custom" && object.customGeometry) {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.Float32BufferAttribute(object.customGeometry.positions, 3));
    geo.setAttribute("normal", new THREE.Float32BufferAttribute(object.customGeometry.normals, 3));
    geo.setIndex(object.customGeometry.indices);
    return geo;
  }
  const p = object.geometryParams ?? {};
  switch (object.geometry) {
    case "box":
      return new THREE.BoxGeometry(p.width ?? 1, p.height ?? 1, p.depth ?? 1);
    case "sphere":
      return new THREE.SphereGeometry(p.radius ?? 0.5, p.widthSegments ?? 32, p.heightSegments ?? 16);
    case "cylinder":
      return new THREE.CylinderGeometry(p.radiusTop ?? 0.5, p.radiusBottom ?? 0.5, p.height ?? 1, p.radialSegments ?? 32);
    case "cone":
      return new THREE.ConeGeometry(p.radius ?? 0.5, p.height ?? 1, p.radialSegments ?? 32);
    case "torus":
      return new THREE.TorusGeometry(p.radius ?? 0.5, p.tube ?? 0.2, p.radialSegments ?? 16, p.tubularSegments ?? 32);
    case "plane":
      return new THREE.PlaneGeometry(p.width ?? 1, p.height ?? 1);
    default:
      return new THREE.SphereGeometry(0.5, 16, 16);
  }
}

interface SceneBodyProps {
  object: SceneObject;
}

/** One `SceneObject` rendered as a mesh inside a Rapier `RigidBody`, registered for grab/squash. */
function SceneBody({ object }: SceneBodyProps) {
  const geometry = useMemo(() => buildGeometry(object), [object.geometry, object.geometryParams, object.customGeometry]);
  const bodyRef = useRef<RapierRigidBody>(null);
  const meshRef = useRef<THREE.Mesh>(null);

  useEffect(() => {
    registerBody(object.id, bodyRef.current);
    return () => registerBody(object.id, null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [object.id]);

  useEffect(() => {
    registerMesh(object.id, meshRef.current, object.scale);
    return () => registerMesh(object.id, null, object.scale);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [object.id, object.scale]);

  return (
    <RigidBody
      ref={bodyRef}
      type={object.physics === "dynamic" ? "dynamic" : "fixed"}
      colliders="hull"
      position={object.position}
      rotation={object.rotation}
      restitution={0.5}
      friction={0.8}
    >
      <mesh ref={meshRef} geometry={geometry} scale={object.scale} castShadow receiveShadow>
        <meshStandardMaterial
          color={object.material.color}
          metalness={object.material.metalness}
          roughness={object.material.roughness}
          emissive={object.material.emissive}
          emissiveIntensity={object.material.emissiveIntensity}
        />
      </mesh>
    </RigidBody>
  );
}

/** Maps every store `SceneObject` to a physics-backed `SceneBody`, kept in sync via the store subscription. */
function SceneBodies() {
  const objects = useEditor((s) => s.objects);
  return (
    <>
      {objects.map((object) => (
        <SceneBody key={object.id} object={object} />
      ))}
    </>
  );
}

/** Per-frame driver for grab-follow and squash easing; mounted once inside `<Physics>`. */
function PhysicsRuntime() {
  useFrame(() => {
    for (const [id, point] of grabPoints) {
      const body = bodies.get(id);
      if (body) body.setNextKinematicTranslation(point);
    }

    for (const [id, target] of squashTargets) {
      const current = squashCurrent.get(id) ?? 0;
      const next = THREE.MathUtils.lerp(current, target, SQUASH_RISE);
      const decayedTarget = target * SQUASH_DECAY;

      if (next < SQUASH_EPSILON && decayedTarget < SQUASH_EPSILON) {
        squashCurrent.delete(id);
        squashTargets.delete(id);
        applyScale(id, 0);
        continue;
      }

      squashCurrent.set(id, next);
      squashTargets.set(id, decayedTarget);
      applyScale(id, next);
    }
  });
  return null;
}

/** Applies a volume-ish-preserving squash (flatten Y, bulge X/Z) for eased force `f` in 0..1. */
function applyScale(id: string, f: number): void {
  const mesh = meshes.get(id);
  const base = baseScales.get(id) ?? [1, 1, 1];
  if (!mesh) return;
  const sy = 1 - Math.min(f, 0.95) * 0.6;
  const sxz = 1 / Math.sqrt(sy);
  mesh.scale.set(base[0] * sxz, base[1] * sy, base[2] * sxz);
}

/** Root Rapier physics provider for the scene: gravity, all store scene bodies, and the grab/squash frame loop. */
export default function PhysicsWorld({ children }: PhysicsWorldProps) {
  return (
    <Physics gravity={[0, -9.81, 0]}>
      <SceneBodies />
      <PhysicsRuntime />
      {children}
    </Physics>
  );
}

/**
 * Sets object `id` kinematic and drives it toward `handWorldPos` every physics frame until
 * `release` is called. No-op if `id` has no registered rigid body.
 */
export function grab(id: string, handWorldPos: [number, number, number]): void {
  const body = bodies.get(id);
  if (!body) return;
  body.setBodyType(RigidBodyType.KinematicPositionBased, true);
  const point = grabPoints.get(id) ?? new THREE.Vector3();
  point.set(handWorldPos[0], handWorldPos[1], handWorldPos[2]);
  grabPoints.set(id, point);
}

/**
 * Releases object `id` back to dynamic simulation, inheriting `velocity` (a fast release
 * throws it). Also marks the object `"dynamic"` in the scene store.
 * @remarks The store `setPhysics` call is best-effort: it's swallowed if the store or the id
 * isn't wired up (e.g. a standalone debug body), so the physics loop never crashes on it.
 */
export function release(id: string, velocity: [number, number, number]): void {
  grabPoints.delete(id);
  const body = bodies.get(id);
  if (body) {
    body.setBodyType(RigidBodyType.Dynamic, true);
    body.setLinvel({ x: velocity[0], y: velocity[1], z: velocity[2] }, true);
  }
  try {
    useEditor.getState().setPhysics(id, "dynamic");
  } catch {
    // Store action not wired for this id yet (e.g. debug-only body) — ignore.
  }
}

/**
 * Applies a squash-and-stretch scale to object `id` proportional to `force` (0..1); call
 * again each frame while squeezing. Stops being called → the effect eases back to (1,1,1)
 * automatically (exponential decay of the last requested force).
 */
export function squash(id: string, force: number): void {
  squashTargets.set(id, THREE.MathUtils.clamp(force, 0, 1));
}

/**
 * Ergonomic hook form of the module-level grab/release/squash API, for consumers (like
 * `useFusion`) that prefer hook-style access over importing the functions directly.
 */
export function usePhysicsControls() {
  return { grab, release, squash };
}
