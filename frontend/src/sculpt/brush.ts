/**
 * BVH-accelerated radius-query brush that displaces clay geometry vertices (Task D).
 * @remarks Pure function — testable offline against a mock mesh. Uses three-mesh-bvh for the
 * "vertices near the brush" query; recomputes normals after displacement.
 */
import type { SerializableGeometry } from "../types";

/**
 * Displaces vertices of `geo` within `radius` of `hitPointLocal`, along `normalLocal`,
 * scaled by `force` and `SCULPT_STRENGTH`, then recomputes normals.
 * @param dir -1 presses in, +1 pulls out (taffy).
 */
export function applyBrush(
  _geo: SerializableGeometry,
  _hitPointLocal: [number, number, number],
  _normalLocal: [number, number, number],
  _radius: number,
  _force: number,
  _dir: -1 | 1,
): SerializableGeometry {
  throw new Error("notImplemented: applyBrush");
}
