/**
 * Derives a fused `HandState` (cursor, pinch/open pose) from raw vision landmarks (Task C).
 * @remarks Cursor = midpoint of thumb tip (4) and index tip (8), EMA-smoothed (factor 0.2).
 * Depth proxy = 1 - handDiagonal/canvasDiagonal.
 */
import type { VisionHand } from "../contracts";
import type { HandState } from "../types";

/** Computes the current frame's `HandState` from the first detected hand, if any. */
export function useSkeleton(_hands: VisionHand[] | undefined): HandState {
  throw new Error("notImplemented: useSkeleton");
}
