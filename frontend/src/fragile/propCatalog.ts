/**
 * Catalog of squeezable demo props, each with its own force threshold and burst reaction.
 *
 * Generalises what was egg-only special-casing: a prop declares its geometry, its material, the
 * clench that sets it off, whether it survives the squeeze, and what debris it emits. Adding a
 * prop means adding one entry here — the watcher stays generic.
 */
import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { bufferGeometryToSerializable } from "../sculpt/geometry";
import type { SerializableGeometry } from "../types";
import { makeEgg, makeShell, makeShard, makeWillow, makeYolk } from "./fragileGeometry";

export interface Mat {
  color: string; metalness: number; roughness: number; emissive: string; emissiveIntensity: number;
}

/** One piece of debris emitted by a burst. */
export interface Debris {
  geometry: SerializableGeometry;
  material: Mat;
  /** Offset from the burst point, world units. */
  offset: [number, number, number];
  /** Initial velocity, units/sec. */
  velocity: [number, number, number];
}

export interface PropSpec {
  key: string;
  label: string;
  geometry: () => SerializableGeometry;
  material: Mat;
  /** Clench fraction (0..1) that triggers the burst. */
  threshold: number;
  /**
   * False for props that are destroyed by the squeeze (egg, balloon). True for ones that survive
   * and just eject contents — squeezing a ketchup bottle should not delete the bottle.
   */
  survives: boolean;
  debris: () => Debris[];
}

const CREAM: Mat = { color: "#f7efdd", metalness: 0.02, roughness: 0.55, emissive: "#000000", emissiveIntensity: 0 };
const YOLK: Mat = { color: "#ffb300", metalness: 0, roughness: 0.25, emissive: "#c26a00", emissiveIntensity: 0.5 };
const KETCHUP: Mat = { color: "#c1121f", metalness: 0, roughness: 0.3, emissive: "#5c0a10", emissiveIntensity: 0.35 };
const GLASS: Mat = { color: "#d33", metalness: 0.1, roughness: 0.25, emissive: "#000000", emissiveIntensity: 0 };
const RUBBER: Mat = { color: "#ff5aa8", metalness: 0, roughness: 0.4, emissive: "#000000", emissiveIntensity: 0 };
const METAL: Mat = { color: "#9fb4c7", metalness: 0.8, roughness: 0.3, emissive: "#000000", emissiveIntensity: 0 };
const FIZZ: Mat = { color: "#ffe9a8", metalness: 0, roughness: 0.1, emissive: "#8a6a00", emissiveIntensity: 0.4 };
const PEEL: Mat = { color: "#ff8c1a", metalness: 0, roughness: 0.6, emissive: "#000000", emissiveIntensity: 0 };
const JUICE: Mat = { color: "#ffc247", metalness: 0, roughness: 0.2, emissive: "#8a5a00", emissiveIntensity: 0.4 };

/** A blob: small squashed sphere, used for liquids (ketchup, juice, fizz). */
function blob(r: number): SerializableGeometry {
  const g = new THREE.SphereGeometry(r, 10, 8);
  const pos = g.getAttribute("position") as THREE.BufferAttribute;
  const v = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i);
    v.y *= 0.75;
    pos.setXYZ(i, v.x, v.y, v.z);
  }
  g.computeVertexNormals();
  return bufferGeometryToSerializable(g);
}

/** Squeeze bottle: tapered body plus a narrow neck, merged. */
function bottle(): SerializableGeometry {
  const body = new THREE.CylinderGeometry(0.19, 0.24, 0.62, 14);
  const neck = new THREE.CylinderGeometry(0.07, 0.12, 0.22, 12);
  neck.translate(0, 0.42, 0);
  const cap = new THREE.ConeGeometry(0.07, 0.12, 12);
  cap.translate(0, 0.58, 0);
  // Every input must agree on indexing or mergeGeometries returns null.
  const parts = [body, neck, cap].map((p) => (p.getIndex() ? p.toNonIndexed() : p));
  const m = mergeGeometries(parts, false);
  if (!m) throw new Error("bottle: merge failed");
  m.computeVertexNormals();
  return bufferGeometryToSerializable(m);
}

/** Drinks can: a plain cylinder, tall and narrow. */
function can(): SerializableGeometry {
  const g = new THREE.CylinderGeometry(0.17, 0.17, 0.52, 16);
  return bufferGeometryToSerializable(g);
}

/** Balloon: a sphere pulled to a point at the knot. */
function balloon(): SerializableGeometry {
  const g = new THREE.SphereGeometry(0.3, 18, 14);
  const pos = g.getAttribute("position") as THREE.BufferAttribute;
  const v = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i);
    const t = (-v.y / 0.3 + 1) / 2;             // 1 at the bottom
    const pinch = 1 - 0.78 * Math.pow(t, 3.2);
    v.x *= pinch; v.z *= pinch;
    v.y *= 1.18;
    pos.setXYZ(i, v.x, v.y, v.z);
  }
  g.computeVertexNormals();
  return bufferGeometryToSerializable(g);
}

/** Radial spray of liquid blobs, angled upward and outward. */
function spray(n: number, mat: Mat, r: number, speed: number, lift: number): Debris[] {
  return Array.from({ length: n }, (_, i) => {
    const a = (i / n) * Math.PI * 2 + 0.3;
    const jitter = 0.6 + 0.4 * ((i * 5) % 3) / 3;
    return {
      geometry: blob(r * jitter),
      material: mat,
      offset: [Math.cos(a) * 0.1, 0.22, Math.sin(a) * 0.1] as [number, number, number],
      velocity: [Math.cos(a) * speed * jitter, lift * jitter, Math.sin(a) * speed * jitter] as [number, number, number],
    };
  });
}

export const PROPS: PropSpec[] = [
  {
    key: "egg",
    label: "Egg",
    geometry: () => makeEgg(0.42),
    material: CREAM,
    threshold: 0.25,
    survives: false,
    debris: () => [
      { geometry: makeShell(0.42, true), material: CREAM, offset: [0.1, 0.12, 0], velocity: [1.6, 1.4, 0.4] },
      { geometry: makeShell(0.42, false), material: CREAM, offset: [-0.1, -0.05, 0], velocity: [-1.6, 0.9, -0.4] },
      // The yolk slumps rather than flying — a yolk shot sideways reads as a bouncy ball.
      { geometry: makeYolk(0.2), material: YOLK, offset: [0, -0.04, 0], velocity: [0, -0.6, 0] },
    ],
  },
  {
    key: "ketchup",
    label: "Ketchup",
    geometry: bottle,
    material: GLASS,
    threshold: 0.3,
    survives: true,      // squeezing a bottle should not delete the bottle
    debris: () => spray(9, KETCHUP, 0.075, 2.6, 3.2),
  },
  {
    key: "soda",
    label: "Soda can",
    geometry: can,
    material: METAL,
    threshold: 0.55,     // a can takes real force
    survives: true,
    debris: () => spray(12, FIZZ, 0.05, 1.9, 4.4),
  },
  {
    key: "balloon",
    label: "Balloon",
    geometry: balloon,
    material: RUBBER,
    threshold: 0.2,      // pops easily
    survives: false,
    debris: () =>
      Array.from({ length: 7 }, (_, i) => {
        const a = (i / 7) * Math.PI * 2;
        return {
          geometry: makeShard(0.1, i),
          material: RUBBER,
          offset: [Math.cos(a) * 0.08, 0.05, Math.sin(a) * 0.08] as [number, number, number],
          velocity: [Math.cos(a) * 4.2, 2.6, Math.sin(a) * 4.2] as [number, number, number],
        };
      }),
  },
  {
    key: "orange",
    label: "Orange",
    geometry: () => makeEgg(0.3),   // near-spherical; the taper reads as a citrus dimple
    material: PEEL,
    threshold: 0.45,
    survives: false,
    debris: () => [
      ...spray(6, JUICE, 0.06, 2.2, 2.8),
      { geometry: makeShell(0.3, true), material: PEEL, offset: [0.08, 0.08, 0], velocity: [1.4, 1.2, 0.3] },
      { geometry: makeShell(0.3, false), material: PEEL, offset: [-0.08, -0.04, 0], velocity: [-1.4, 0.8, -0.3] },
    ],
  },
  {
    key: "willow",
    label: "One-wish willow",
    geometry: () => makeWillow(0.62),
    material: { color: "#cfe8c8", metalness: 0, roughness: 0.7, emissive: "#1a2a12", emissiveIntensity: 0.25 },
    threshold: 0.35,
    survives: false,
    debris: () => spray(10, { ...FIZZ, color: "#f4ffe8" }, 0.04, 1.2, 3.6),
  },
];

export function findProp(key: string): PropSpec | undefined {
  return PROPS.find((p) => p.key === key);
}
