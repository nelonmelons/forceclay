/**
 * Derives a fused `TwoHandState` (cursor, pinch/hold pose, per Left/Right hand) from raw vision
 * landmarks (Task C), mirroring ShapeShift's `useSkeleton.ts` gesture model.
 * @remarks Cursor = midpoint of thumb tip (4) and index tip (8), EMA-smoothed (factor 0.2), kept
 * per-hand so a module-level reset on one hand's disappearance doesn't disturb the other's
 * smoothing. `isPinching` (all-5-fingertip cluster) drives object grab/drag; `isHolding`
 * (thumb-index, stability-windowed) drives camera navigation — see `control/useFusion.ts` and
 * `scene/cameraGestures.ts`.
 */
import type { VisionHand } from "../contracts";
import type { HandInfo, TwoHandState } from "../types";

/** Original vision-backend frame dimensions; landmarks are normalized to this space. */
export const FRAME_WIDTH = 640;
export const FRAME_HEIGHT = 360;
const CANVAS_DIAG = Math.hypot(FRAME_WIDTH, FRAME_HEIGHT);
const CURSOR_EMA = 0.2;
/** Fingertip cluster radius, as a fraction of PALM length, that counts as a closed grab hand.
 *  Generous on purpose: a missed pickup is far more annoying than an occasional early one. */
const PINCH_TIP_CLUSTER = 0.95;
/** ShapeShift holds the thumb-index distance history over this window to judge `isHolding`. */
const HOLD_STABILITY_WINDOW_MS = 50;
/** Smoothing for the wrist->middle-MCP roll angle used by pinch-to-rotate. */
const ROLL_EMA = 0.3;

type Side = "Left" | "Right";
const SIDES: Side[] = ["Left", "Right"];

/** Module-scoped smoothing/history state, per hand — this is a per-frame fusion loop, not a React hook. */
let prevCursor: Record<Side, { x: number; y: number } | null> = { Left: null, Right: null };
let holdDistHistory: Record<Side, { t: number; d: number }[]> = { Left: [], Right: [] };
let prevRoll: Record<Side, number | null> = { Left: null, Right: null };

function resetSide(side: Side): void {
  prevCursor[side] = null;
  holdDistHistory[side] = [];
  prevRoll[side] = null;
}

/** Shortest-path angular difference `a - b`, wrapped to (-PI, PI]; avoids the EMA jumping when
 *  the raw angle crosses the +-PI seam. */
function angleDiff(a: number, b: number): number {
  let d = a - b;
  while (d > Math.PI) d -= 2 * Math.PI;
  while (d < -Math.PI) d += 2 * Math.PI;
  return d;
}

/** Computes one hand's `HandInfo`, reading/writing that hand's module-level smoothing state. */
function computeHandInfo(hand: VisionHand): HandInfo {
  const side = hand.handedness;
  const thumb = hand.landmarks[4];
  const index = hand.landmarks[8];
  const rawX = (thumb[0] + index[0]) / 2;
  const rawY = (thumb[1] + index[1]) / 2;

  const prev = prevCursor[side];
  const cursorPx = prev
    ? { x: prev.x * (1 - CURSOR_EMA) + rawX * CURSOR_EMA, y: prev.y * (1 - CURSOR_EMA) + rawY * CURSOR_EMA }
    : { x: rawX, y: rawY };
  prevCursor[side] = cursorPx;

  const xs = hand.landmarks.map((l) => l[0]);
  const ys = hand.landmarks.map((l) => l[1]);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  const handDiag = Math.hypot(maxX - minX, maxY - minY);
  const depthProxy = 1 - Math.min(Math.max(handDiag / CANVAS_DIAG, 0), 1);
  const spread = (maxX - minX + (maxY - minY)) / 2;
  const wrist0 = hand.landmarks[0];

  // Pinch: all five fingertips clustered near their centroid (ShapeShift's grab/drag gesture).
  const fingertips = [4, 8, 12, 16, 20].map((i) => hand.landmarks[i]);
  const centroid = [
    fingertips.reduce((s, p) => s + p[0], 0) / fingertips.length,
    fingertips.reduce((s, p) => s + p[1], 0) / fingertips.length,
  ];
  const maxTipDist = Math.max(...fingertips.map((p) => Math.hypot(p[0] - centroid[0], p[1] - centroid[1])));
  // Normalise by PALM length (wrist -> middle MCP), not by the hand's bounding box.
  //
  // `spread` collapses as the hand closes, so `maxTipDist < 0.3 * spread` was a threshold that
  // shrank at exactly the moment it needed to be met -- closing your fist tightened the bar it
  // was being judged against, which is why pickup was so unreliable. Palm length is rigid: it
  // barely changes between an open hand and a fist, so it is a stable scale reference.
  const palmLen = Math.max(
    Math.hypot(hand.landmarks[9][0] - wrist0[0], hand.landmarks[9][1] - wrist0[1]),
    1e-3,
  );
  const isPinching = maxTipDist < PINCH_TIP_CLUSTER * palmLen;
  const avgTipSpread =
    fingertips.reduce((s, p) => s + Math.hypot(p[0] - centroid[0], p[1] - centroid[1]), 0) / fingertips.length;
  const isOpen = avgTipSpread > 0.45 * spread;

  // Hold: thumb-index distance under threshold, held steady over a short window (camera nav gesture).
  const holdDist = Math.hypot(thumb[0] - index[0], thumb[1] - index[1]);
  const now = Date.now();
  const history = holdDistHistory[side];
  history.push({ t: now, d: holdDist });
  while (history.length > 0 && now - history[0].t > HOLD_STABILITY_WINDOW_MS) history.shift();
  const avg = history.reduce((s, e) => s + e.d, 0) / history.length;
  const variance = history.reduce((s, e) => s + (e.d - avg) ** 2, 0) / history.length;
  const std = Math.sqrt(variance);
  const isHolding = avg < 0.25 * spread && std < 0.05 * spread;

  // Roll: angle of the wrist->middle-finger-MCP vector, EMA-smoothed via shortest angular path
  // so the seam at +-PI doesn't cause a smoothing spike.
  const wrist = hand.landmarks[0];
  const middleMcp = hand.landmarks[9];
  const rawRoll = Math.atan2(middleMcp[1] - wrist[1], middleMcp[0] - wrist[0]);
  const prevR = prevRoll[side];
  const roll = prevR == null ? rawRoll : prevR + angleDiff(rawRoll, prevR) * ROLL_EMA;
  prevRoll[side] = roll;

  return {
    cursorPx,
    cursorNdc: {
      x: (cursorPx.x / FRAME_WIDTH) * 2 - 1,
      y: -((cursorPx.y / FRAME_HEIGHT) * 2 - 1),
    },
    depthProxy,
    isPinching,
    isOpen,
    isHolding,
    roll,
  };
}

/**
 * Computes the current frame's `TwoHandState` from all detected hands, keyed by
 * MediaPipe `handedness`. A side resets its smoothing/history state the moment it's no longer
 * detected, so a hand re-entering frame doesn't inherit stale history.
 */
export function useSkeleton(hands: VisionHand[] | undefined): TwoHandState {
  const bySide: Record<Side, VisionHand | undefined> = {
    Left: hands?.find((h) => h.handedness === "Left"),
    Right: hands?.find((h) => h.handedness === "Right"),
  };

  for (const side of SIDES) if (!bySide[side]) resetSide(side);

  return {
    left: bySide.Left ? computeHandInfo(bySide.Left) : null,
    right: bySide.Right ? computeHandInfo(bySide.Right) : null,
  };
}

/**
 * Convenience "primary hand" accessor for call sites that only care about one hand (grab/sculpt/
 * vertex-edit raycasts). Prefers the right hand, falling back to the left — mirrors ShapeShift's
 * `refHand = interactionRef.current.Right || interactionRef.current.Left`.
 */
export function getPrimaryHand(hands: TwoHandState): HandInfo | null {
  return hands.right ?? hands.left;
}
