/**
 * Renders a single `SceneObject` — primitive geometry or `customGeometry` for sculpted clay
 * (Task C).
 */
import { useMemo } from "react";
import * as THREE from "three";
import type { SceneObject } from "../types";

export interface ClayObjectProps {
  object: SceneObject;
}

/** Builds a three.js `BufferGeometry` for `object`, using `customGeometry` buffers when `geometry === "custom"`. */
function buildGeometry(object: SceneObject): THREE.BufferGeometry {
  const p = object.geometryParams ?? {};
  switch (object.geometry) {
    case "box":
      return new THREE.BoxGeometry(p.width ?? 1, p.height ?? 1, p.depth ?? 1);
    case "sphere": {
      const g = new THREE.SphereGeometry(p.radius ?? 0.5, 32, 32);
      g.computeVertexNormals();
      return g;
    }
    case "cylinder":
      return new THREE.CylinderGeometry(p.radiusTop ?? 0.5, p.radiusBottom ?? 0.5, p.height ?? 1, 32);
    case "cone":
      return new THREE.ConeGeometry(p.radius ?? 0.5, p.height ?? 1, 32);
    case "torus": {
      const g = new THREE.TorusGeometry(p.radius ?? 0.5, p.tube ?? 0.2, 16, 32);
      g.computeVertexNormals();
      return g;
    }
    case "plane":
      return new THREE.PlaneGeometry(p.width ?? 1, p.height ?? 1);
    case "custom": {
      const g = new THREE.BufferGeometry();
      const custom = object.customGeometry;
      if (custom) {
        g.setAttribute("position", new THREE.Float32BufferAttribute(custom.positions, 3));
        if (custom.indices.length) g.setIndex(custom.indices);
        if (custom.normals.length) g.setAttribute("normal", new THREE.Float32BufferAttribute(custom.normals, 3));
        else g.computeVertexNormals();
      }
      return g;
    }
    default:
      return new THREE.BoxGeometry(1, 1, 1);
  }
}

/** Renders one `SceneObject` as a mesh, choosing primitive vs. custom `BufferGeometry`, with its material incl. emissive glow. */
export default function ClayObject({ object }: ClayObjectProps) {
  // Custom geometry is rebuilt whenever its buffers change (sculpt edits); primitives rebuild on param change.
  const geometry = useMemo(() => buildGeometry(object), [
    object.geometry,
    object.geometryParams,
    object.customGeometry,
  ]);

  return (
    <mesh
      geometry={geometry}
      position={object.position}
      rotation={object.rotation}
      scale={object.scale}
      castShadow
      receiveShadow
    >
      <meshStandardMaterial
        color={object.material.color}
        metalness={object.material.metalness}
        roughness={object.material.roughness}
        emissive={object.material.emissive}
        emissiveIntensity={object.material.emissiveIntensity}
      />
    </mesh>
  );
}
