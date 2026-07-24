/**
 * BVH-accelerated radius-query brush that displaces clay geometry vertices (Task D).
 * @remarks Pure function — testable offline against a mock mesh. Uses three-mesh-bvh for the
 * "vertices near the brush" query; recomputes normals after displacement.
 */
import * as THREE from "three";
import { MeshBVH } from "three-mesh-bvh";
import type { SerializableGeometry } from "../types.ts";
import { SCULPT_STRENGTH } from "../contracts.ts";
import { serializableToBufferGeometry, bufferGeometryToSerializable } from "./geometry.ts";

/** Smoothstep falloff: 1 at the brush center, 0 at (and beyond) `radius`. */
function smoothstepFalloff(dist: number, radius: number): number {
  const t = Math.min(Math.max(1 - dist / radius, 0), 1);
  return t * t * (3 - 2 * t);
}

/**
 * Displaces vertices of `geo` within `radius` of `hitPointLocal`, along each vertex's own
 * normal, scaled by `force` and `SCULPT_STRENGTH`, then recomputes normals.
 * @param dir -1 presses in, +1 pulls out (taffy).
 * @remarks `normalLocal` is accepted per the pinned contract (brush orientation) but the
 * actual displacement direction is each affected vertex's own normal, per the plan's
 * "Deformation detail" note — this keeps the surface pushing outward/inward naturally
 * rather than uniformly along one direction.
 */
export function applyBrush(
  geo: SerializableGeometry,
  hitPointLocal: [number, number, number],
  _normalLocal: [number, number, number],
  radius: number,
  force: number,
  dir: -1 | 1,
): SerializableGeometry {
  const bufferGeo = serializableToBufferGeometry(geo);
  const bvh = new MeshBVH(bufferGeo);

  const center = new THREE.Vector3(...hitPointLocal);
  const sphere = new THREE.Sphere(center, radius);

  const affected = new Set<number>();
  bvh.shapecast({
    intersectsBounds: (box) => sphere.intersectsBox(box),
    intersectsTriangle: (_triangle, triangleIndex) => {
      const index = bufferGeo.index!;
      const base = triangleIndex * 3;
      affected.add(index.getX(base));
      affected.add(index.getX(base + 1));
      affected.add(index.getX(base + 2));
      return false; // keep traversing to collect every overlapping vertex
    },
  });

  const positions = Float32Array.from(geo.positions);
  const normals = geo.normals.length === geo.positions.length ? geo.normals : new Array(geo.positions.length).fill(0);
  const vertex = new THREE.Vector3();
  const normal = new THREE.Vector3();

  for (const i of affected) {
    const base = i * 3;
    vertex.set(positions[base], positions[base + 1], positions[base + 2]);
    normal.set(normals[base], normals[base + 1], normals[base + 2]);
    const dist = vertex.distanceTo(center);
    if (dist > radius) continue;
    const falloff = smoothstepFalloff(dist, radius);
    const displacement = falloff * force * SCULPT_STRENGTH * dir;
    positions[base] += normal.x * displacement;
    positions[base + 1] += normal.y * displacement;
    positions[base + 2] += normal.z * displacement;
  }

  const resultGeo = new THREE.BufferGeometry();
  resultGeo.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  resultGeo.setIndex(geo.indices);
  resultGeo.computeVertexNormals();

  return bufferGeometryToSerializable(resultGeo);
}
