/**
 * Derives a fused `HandState` (cursor, pinch/open pose) from raw vision landmarks (Task C).
 * @remarks Cursor = midpoint of thumb tip (4) and index tip (8), EMA-smoothed (factor 0.2).
 * Depth proxy = 1 - handDiagonal/canvasDiagonal.
 */
import type { VisionHand } from "../contracts";
import type { HandState } from "../types";

const FRAME_WIDTH = 640;
const FRAME_HEIGHT = 360;
const CANVAS_DIAG = Math.hypot(FRAME_WIDTH, FRAME_HEIGHT);
const CURSOR_EMA = 0.2;
const PINCH_STABILITY_WINDOW_MS = 120;

/** Module-scoped smoothing/history state — this is a per-frame fusion loop, not a React hook. */
let prevCursor: { x: number; y: number } | null = null;
let pinchDistHistory: { t: number; d: number }[] = [];

function resetSkeletonState() {
  prevCursor = null;
  pinchDistHistory = [];
}

/**
 * Computes the current frame's `HandState` from the first detected hand, if any.
 * @remarks Cursor = EMA-smoothed (0.2) midpoint of thumb tip (landmark 4) and index tip (8).
 * `isPinching` requires the thumb-index distance to stay under 0.25*handSpread over a short
 * stability window (not just a single-frame threshold crossing).
 */
export function useSkeleton(hands: VisionHand[] | undefined): HandState {
  const hand = hands?.[0];
  if (!hand) {
    resetSkeletonState();
    return {
      present: false,
      cursorPx: { x: 0, y: 0 },
      cursorNdc: { x: 0, y: 0 },
      depthProxy: 0,
      isPinching: false,
      isOpen: false,
    };
  }

  const thumb = hand.landmarks[4];
  const index = hand.landmarks[8];
  const rawX = (thumb[0] + index[0]) / 2;
  const rawY = (thumb[1] + index[1]) / 2;
  const cursorPx = prevCursor
    ? { x: prevCursor.x * (1 - CURSOR_EMA) + rawX * CURSOR_EMA, y: prevCursor.y * (1 - CURSOR_EMA) + rawY * CURSOR_EMA }
    : { x: rawX, y: rawY };
  prevCursor = cursorPx;

  const xs = hand.landmarks.map((l) => l[0]);
  const ys = hand.landmarks.map((l) => l[1]);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  const handDiag = Math.hypot(maxX - minX, maxY - minY);
  const depthProxy = 1 - Math.min(Math.max(handDiag / CANVAS_DIAG, 0), 1);
  const spread = (maxX - minX + (maxY - minY)) / 2;

  // Pinch: thumb-index distance under threshold, held steady over a short window.
  const pinchDist = Math.hypot(thumb[0] - index[0], thumb[1] - index[1]);
  const now = Date.now();
  pinchDistHistory.push({ t: now, d: pinchDist });
  pinchDistHistory = pinchDistHistory.filter((e) => now - e.t <= PINCH_STABILITY_WINDOW_MS);
  const avgPinchDist = pinchDistHistory.reduce((s, e) => s + e.d, 0) / pinchDistHistory.length;
  const pinchVariance =
    pinchDistHistory.reduce((s, e) => s + (e.d - avgPinchDist) ** 2, 0) / pinchDistHistory.length;
  const pinchThreshold = 0.25 * spread;
  const isPinching = pinchDist < pinchThreshold && Math.sqrt(pinchVariance) < 0.1 * spread;

  // Open: fingertips spread wide from their centroid relative to hand size.
  const fingertips = [4, 8, 12, 16, 20].map((i) => hand.landmarks[i]);
  const centroid = [
    fingertips.reduce((s, p) => s + p[0], 0) / fingertips.length,
    fingertips.reduce((s, p) => s + p[1], 0) / fingertips.length,
  ];
  const avgTipSpread =
    fingertips.reduce((s, p) => s + Math.hypot(p[0] - centroid[0], p[1] - centroid[1]), 0) / fingertips.length;
  const isOpen = avgTipSpread > 0.45 * spread;

  return {
    present: true,
    cursorPx,
    cursorNdc: {
      x: (cursorPx.x / FRAME_WIDTH) * 2 - 1,
      y: -((cursorPx.y / FRAME_HEIGHT) * 2 - 1),
    },
    depthProxy,
    isPinching,
    isOpen,
  };
}
