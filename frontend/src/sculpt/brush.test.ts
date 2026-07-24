/**
 * Smoke test for the sculpt brush (Task D verification).
 * @remarks Run with: `node --experimental-strip-types src/sculpt/brush.test.ts` from `frontend/`.
 * Not a vitest suite (none installed in this worktree) — plain assertions + process.exit.
 */
import * as THREE from "three";
import { makeClaySphere } from "./geometry.ts";
import { applyBrush } from "./brush.ts";

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(`FAIL: ${msg}`);
  console.log(`ok - ${msg}`);
}

// Note: three's IcosahedronGeometry(radius, detail) segments each edge into `detail` parts
// (not 4^detail recursive subdivision), so detail=14 -- rather than the plan's illustrative
// detail=4 -- is what actually lands in the ~2-5k welded-vertex range used here.
const radius = 1;
const geo = makeClaySphere(radius, 14);
assert(geo.positions.length / 3 >= 2000 && geo.positions.length / 3 <= 5000, `vertex count in [2000,5000], got ${geo.positions.length / 3}`);
assert(geo.normals.length === geo.positions.length, "normals length matches positions length before brushing");

// Pick a surface point: the +Z pole direction, find the closest actual vertex to it.
const target = new THREE.Vector3(0, 0, radius);
let closestIdx = 0;
let closestDist = Infinity;
for (let i = 0; i < geo.positions.length / 3; i++) {
  const v = new THREE.Vector3(geo.positions[i * 3], geo.positions[i * 3 + 1], geo.positions[i * 3 + 2]);
  const d = v.distanceTo(target);
  if (d < closestDist) {
    closestDist = d;
    closestIdx = i;
  }
}
const before = new THREE.Vector3(geo.positions[closestIdx * 3], geo.positions[closestIdx * 3 + 1], geo.positions[closestIdx * 3 + 2]);
const beforeDistFromCenter = before.length();

const brushRadius = 0.4;
const force = 1;
const hitPoint: [number, number, number] = [before.x, before.y, before.z];
const normalAtHit: [number, number, number] = before.clone().normalize().toArray() as [number, number, number];

const result = applyBrush(geo, hitPoint, normalAtHit, brushRadius, force, -1);

assert(result.normals.length === result.positions.length, "output normals array length matches output positions length");
assert(result.positions.length === geo.positions.length, "vertex count preserved");

const after = new THREE.Vector3(result.positions[closestIdx * 3], result.positions[closestIdx * 3 + 1], result.positions[closestIdx * 3 + 2]);
const afterDistFromCenter = after.length();

assert(afterDistFromCenter < beforeDistFromCenter, `pressed vertex moved inward (before=${beforeDistFromCenter.toFixed(4)}, after=${afterDistFromCenter.toFixed(4)})`);

// Original geometry must be untouched (pure function, no mutation).
assert(geo.positions[closestIdx * 3 + 2] === before.z, "input geometry not mutated");

// A vertex far outside the brush radius should be unaffected.
let farIdx = 0;
let farDist = 0;
for (let i = 0; i < geo.positions.length / 3; i++) {
  const v = new THREE.Vector3(geo.positions[i * 3], geo.positions[i * 3 + 1], geo.positions[i * 3 + 2]);
  const d = v.distanceTo(before);
  if (d > farDist) {
    farDist = d;
    farIdx = i;
  }
}
assert(
  Math.abs(result.positions[farIdx * 3] - geo.positions[farIdx * 3]) < 1e-9 &&
    Math.abs(result.positions[farIdx * 3 + 1] - geo.positions[farIdx * 3 + 1]) < 1e-9 &&
    Math.abs(result.positions[farIdx * 3 + 2] - geo.positions[farIdx * 3 + 2]) < 1e-9,
  "vertex far outside brush radius is unaffected",
);

console.log("ALL PASS");
