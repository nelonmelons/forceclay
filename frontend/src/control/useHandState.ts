/**
 * Shared per-frame `TwoHandState` store, written by the single call site that invokes
 * `hands/useSkeleton.ts` (inside `useFusion`) and read by any other consumer that needs the
 * current hand pose (e.g. `VertexEditHandles`).
 * @remarks `useSkeleton` keeps module-level EMA/pinch-history state meant for exactly one
 * call site per frame; calling it from two independent components would corrupt that
 * smoothing. This store lets a second consumer read the already-computed `TwoHandState`
 * instead of calling `useSkeleton` again. Use `hands/useSkeleton.ts`'s `getPrimaryHand` to pick
 * a single hand out of the pair when a consumer only needs one (e.g. `VertexEditHandles`'s
 * pinch-drag raycast).
 */
import { create } from "zustand";
import type { TwoHandState } from "../types";

const EMPTY_HANDS: TwoHandState = { left: null, right: null };

/** Latest `TwoHandState` computed this frame by `useFusion`'s single `useSkeleton` call. */
export const useHandState = create<TwoHandState>(() => EMPTY_HANDS);
