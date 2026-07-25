/**
 * Procedural geometry for the two fragile demo props: an egg and a one-wish willow.
 *
 * Both are emitted as `SerializableGeometry` ("custom") so `ClayObject` renders them through
 * its existing custom-buffer path — no new `GeometryKind` and no change to the renderer.
 */
import * as THREE from "three";
import { mergeGeometries, mergeVertices } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { bufferGeometryToSerializable } from "../sculpt/geometry.ts";

/**
 * Serialize a geometry, welding it first if it is non-indexed.
 *
 * bufferGeometryToSerializable throws on non-indexed input, and several three.js primitives are
 * non-indexed (IcosahedronGeometry, anything out of mergeGeometries). Those throws killed the
 * prop spawn, and Rapier then crashed the whole Canvas trying to build a hull collider from the
 * missing geometry -- a white screen.
 */
export function toSerializable(geom: THREE.BufferGeometry): SerializableGeometry {
  const indexed = geom.getIndex() ? geom : mergeVertices(geom);
  indexed.computeVertexNormals();
  return bufferGeometryToSerializable(indexed);
}
import type { SerializableGeometry } from "../types.ts";

/**
 * An egg: a sphere with a vertical stretch and an asymmetric taper.
 *
 * The taper is what makes it read as an egg rather than an ellipsoid — real eggs are narrower
 * at one end, so the radial scale falls off with height rather than staying constant.
 */
export function makeEgg(radius = 0.5, detail = 4): SerializableGeometry {
  const g = new THREE.SphereGeometry(radius, 24, 18);
  const pos = g.getAttribute("position") as THREE.BufferAttribute;
  const v = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i);
    const t = (v.y / radius + 1) / 2;            // 0 at the bottom, 1 at the top
    const taper = 1 - 0.34 * Math.pow(t, 2.1);   // narrow the top end
    v.x *= taper;
    v.z *= taper;
    v.y *= 1.34;                                 // stretch along the long axis
    pos.setXYZ(i, v.x, v.y, v.z);
  }
  g.computeVertexNormals();
  void detail;
  return toSerializable(g);
}

/**
 * A one-wish willow: a slim trunk, drooping branch strands, and a seed puff on top.
 *
 * Branches are built as short cylinders stepped along a drooping arc rather than as tube
 * geometry — far fewer triangles for the same silhouette, which matters because this is a
 * physics body being carried at 60 fps.
 */
export function makeWillow(scale = 0.5): SerializableGeometry {
  const parts: THREE.BufferGeometry[] = [];

  const trunkH = 1.5 * scale;
  const trunk = new THREE.CylinderGeometry(0.045 * scale, 0.075 * scale, trunkH, 8);
  trunk.translate(0, trunkH / 2 - 0.6 * scale, 0);
  parts.push(trunk);

  // Drooping strands: each is a chain of short segments following a downward-curving arc.
  const STRANDS = 7;
  const SEGS = 5;
  for (let s = 0; s < STRANDS; s++) {
    const a = (s / STRANDS) * Math.PI * 2;
    const reach = (0.34 + 0.16 * ((s * 7) % 5) / 5) * scale;
    let px = 0, py = trunkH - 0.6 * scale, pz = 0;
    for (let k = 1; k <= SEGS; k++) {
      const t = k / SEGS;
      const nx = Math.cos(a) * reach * t;
      const nz = Math.sin(a) * reach * t;
      // Quadratic droop: nearly flat leaving the trunk, steep at the tip.
      const ny = trunkH - 0.6 * scale - 0.85 * scale * t * t;
      const seg = new THREE.Vector3(nx - px, ny - py, nz - pz);
      const len = seg.length();
      if (len > 1e-5) {
        const c = new THREE.CylinderGeometry(0.014 * scale, 0.02 * scale, len, 5);
        const q = new THREE.Quaternion().setFromUnitVectors(
          new THREE.Vector3(0, 1, 0), seg.clone().divideScalar(len),
        );
        c.applyQuaternion(q);
        c.translate(px + seg.x / 2, py + seg.y / 2, pz + seg.z / 2);
        parts.push(c);
      }
      px = nx; py = ny; pz = nz;
    }
  }

  const puff = new THREE.IcosahedronGeometry(0.2 * scale, 1);
  puff.translate(0, trunkH - 0.52 * scale, 0);
  parts.push(puff);

  // mergeGeometries requires every input to agree on indexing. CylinderGeometry is indexed
  // and IcosahedronGeometry is not, so merging them raw returns null and the spawn threw --
  // which is why the willow never appeared. Flatten them all first.
  const merged = mergeGeometries(parts.map((p) => (p.getIndex() ? p.toNonIndexed() : p)), false);
  if (!merged) throw new Error("makeWillow: geometry merge failed");
  merged.computeVertexNormals();
  return toSerializable(merged);
}

/**
 * A shard for the crack effect: a small irregular tetra-ish chunk.
 *
 * Vertices are jittered deterministically from `seed` so every shard differs but a given
 * shard index always looks the same — random geometry would make the break flicker if React
 * re-rendered it.
 */
export function makeShard(size = 0.16, seed = 0): SerializableGeometry {
  const g = new THREE.IcosahedronGeometry(size, 0);
  const pos = g.getAttribute("position") as THREE.BufferAttribute;
  const v = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i);
    // Cheap deterministic hash -> [0.55, 1.0] radial jitter.
    const h = Math.abs(Math.sin((i + 1) * 12.9898 + seed * 78.233) * 43758.5453) % 1;
    v.multiplyScalar(0.55 + 0.45 * h);
    pos.setXYZ(i, v.x, v.y, v.z);
  }
  g.computeVertexNormals();
  return toSerializable(g);
}

/** Names that mark an object as breakable, and the force fraction that cracks it. */
export const FRAGILE_PREFIX = "fragile:";
/** Clench fraction above which a held fragile object breaks. */
export const CRACK_FORCE = 0.25;

/** A yolk: a squashed sphere, so it reads as a blob rather than a ball. */
export function makeYolk(radius = 0.2): SerializableGeometry {
  const g = new THREE.SphereGeometry(radius, 18, 14);
  const pos = g.getAttribute("position") as THREE.BufferAttribute;
  const v = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i);
    v.y *= 0.62;                 // flatten
    v.x *= 1.1; v.z *= 1.1;      // spread
    pos.setXYZ(i, v.x, v.y, v.z);
  }
  g.computeVertexNormals();
  return toSerializable(g);
}

/** A shell half: a hemisphere-ish cap, jittered so the two halves differ. */
export function makeShell(radius = 0.42, up = true): SerializableGeometry {
  const g = new THREE.SphereGeometry(radius, 16, 10, 0, Math.PI * 2, up ? 0 : Math.PI / 2, Math.PI / 2);
  const pos = g.getAttribute("position") as THREE.BufferAttribute;
  const v = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i);
    v.y *= 1.3;
    const h = Math.abs(Math.sin((i + 1) * 9.71) * 4375.85) % 1;
    v.multiplyScalar(0.92 + 0.16 * h);   // ragged break edge
    pos.setXYZ(i, v.x, v.y, v.z);
  }
  g.computeVertexNormals();
  return toSerializable(g);
}
