/**
 * Shared per-frame `HandState` store, written by the single call site that invokes
 * `hands/useSkeleton.ts` (inside `useFusion`) and read by any other consumer that needs the
 * current hand pose (e.g. `VertexEditHandles`).
 * @remarks `useSkeleton` keeps module-level EMA/pinch-history state meant for exactly one
 * call site per frame; calling it from two independent components would corrupt that
 * smoothing. This store lets a second consumer read the already-computed `HandState` instead
 * of calling `useSkeleton` again.
 */
import { create } from "zustand";
import type { HandState } from "../types";

const EMPTY_HAND: HandState = {
  present: false,
  cursorPx: { x: 0, y: 0 },
  cursorNdc: { x: 0, y: 0 },
  depthProxy: 0,
  isPinching: false,
  isOpen: false,
  handAngle: 0,
};

/** Latest `HandState` computed this frame by `useFusion`'s single `useSkeleton` call. */
export const useHandState = create<HandState>(() => EMPTY_HAND);
