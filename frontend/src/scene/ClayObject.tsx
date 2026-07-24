/**
 * Renders a single `SceneObject` — primitive geometry or `customGeometry` for sculpted clay
 * (Task C).
 */
import type { SceneObject } from "../types";

export interface ClayObjectProps {
  object: SceneObject;
}

/** Renders one `SceneObject` as a mesh, choosing primitive vs. custom `BufferGeometry`. */
export default function ClayObject(_props: ClayObjectProps) {
  throw new Error("notImplemented: ClayObject");
}
