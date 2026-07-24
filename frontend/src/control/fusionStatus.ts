/**
 * Live fusion/interaction status store, written every frame by `useFusion` and read by DOM
 * overlays (`ForceHUD`) and in-Canvas components (`PhysicsWorld`'s delete-hover highlight).
 * @remarks Split into its own leaf module (no imports from `useFusion.ts`/`PhysicsWorld.tsx`)
 * so those two files can both depend on it without an import cycle.
 */
import { create } from "zustand";
import type { InteractionMode } from "../types";

/** Live fusion status exposed to DOM overlays and in-Canvas consumers outside the fusion hook. */
export interface FusionStatus {
  interactionMode: InteractionMode;
  force: number;
  calibrated: boolean;
  connectionStatus: "connecting" | "connected" | "disconnected";
  hasHit: boolean;
  /** Object currently under the hand cursor's raycast this frame, if any. */
  hoveredObjectId: string | null;
  /** Object currently being carried (grabbed), if any. */
  heldObjectId: string | null;
  /** 0..1 progress toward auto-pinning the currently-held object (hold-to-pin). */
  pinProgress: number;
  /** Object currently charging toward a hold-to-pin, if any. */
  pinningId: string | null;
}

/** Zustand store mirroring the latest fusion status; written by `useFusion`, read by UI. */
export const useFusionStatus = create<FusionStatus>(() => ({
  interactionMode: "select",
  force: 0,
  calibrated: false,
  connectionStatus: "disconnected",
  hasHit: false,
  hoveredObjectId: null,
  heldObjectId: null,
  pinProgress: 0,
  pinningId: null,
}));
