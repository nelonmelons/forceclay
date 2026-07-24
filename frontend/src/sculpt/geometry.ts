/**
 * Base clay geometry construction and (de)serialization helpers (Task D).
 */
import * as THREE from "three";
import { mergeVertices } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import type { SerializableGeometry } from "../types.ts";

/**
 * Builds a subdivided icosphere of the given radius/detail as starting clay geometry.
 * @remarks `detail` maps directly to three's `IcosahedronGeometry` subdivision level, which
 * subdivides each edge linearly (~10*detail^2+2 vertices) rather than exponentially — a low
 * detail like 4 (~162 verts) is far too coarse to sculpt. Callers spawning clay should use
 * `detail: 14` (~2.3k verts), the resolution the brush/BVH need for smooth deformation.
 * `IcosahedronGeometry` is non-indexed (duplicated verts per face) so we weld it with
 * `mergeVertices` to get the shared, indexed buffers the brush/BVH need.
 */
export function makeClaySphere(radius: number, detail: number): SerializableGeometry {
  const icosahedron = new THREE.IcosahedronGeometry(radius, detail);
  const indexed = mergeVertices(icosahedron) as THREE.BufferGeometry;
  indexed.computeVertexNormals();
  return bufferGeometryToSerializable(indexed);
}

/** Converts a three `BufferGeometry` (must be indexed, with position + normal attributes) to plain arrays. */
export function bufferGeometryToSerializable(geo: THREE.BufferGeometry): SerializableGeometry {
  const position = geo.attributes.position;
  const normal = geo.attributes.normal;
  const index = geo.index;
  if (!index) throw new Error("bufferGeometryToSerializable: geometry must be indexed");
  return {
    positions: Array.from(position.array as Float32Array),
    indices: Array.from(index.array as Uint16Array | Uint32Array),
    normals: normal ? Array.from(normal.array as Float32Array) : [],
  };
}

/** Converts a `SerializableGeometry` back into a three `BufferGeometry` (indexed, with normals). */
export function serializableToBufferGeometry(geo: SerializableGeometry): THREE.BufferGeometry {
  const bg = new THREE.BufferGeometry();
  bg.setAttribute("position", new THREE.Float32BufferAttribute(geo.positions, 3));
  bg.setIndex(geo.indices);
  if (geo.normals.length === geo.positions.length) {
    bg.setAttribute("normal", new THREE.Float32BufferAttribute(geo.normals, 3));
  } else {
    bg.computeVertexNormals();
  }
  return bg;
}
