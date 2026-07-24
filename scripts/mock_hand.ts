/**
 * Optional synthetic `HandState` generator for offline frontend dev without a webcam or
 * vision backend running.
 * @remarks Sweeps the cursor in a slow circle and pulses pinch/open every couple seconds, so
 * downstream consumers (fusion/sculpt/physics) can be exercised without hardware.
 */
import type { HandState } from "../frontend/src/types";

const CANVAS_W = 640;
const CANVAS_H = 360;

/**
 * Returns a synthetic `HandState` for the given elapsed time (seconds), circling the cursor
 * and toggling pinch/open on a fixed cadence.
 */
export function mockHandState(tSeconds: number): HandState {
  const cx = CANVAS_W / 2;
  const cy = CANVAS_H / 2;
  const radius = 100;
  const angle = tSeconds * 0.8;
  const x = cx + radius * Math.cos(angle);
  const y = cy + radius * Math.sin(angle);
  const cyclePos = tSeconds % 4;
  const isPinching = cyclePos < 1.5;
  const isOpen = !isPinching;

  return {
    present: true,
    cursorPx: { x, y },
    cursorNdc: { x: (x / CANVAS_W) * 2 - 1, y: -((y / CANVAS_H) * 2 - 1) },
    depthProxy: 0.5 + 0.1 * Math.sin(angle * 0.5),
    isPinching,
    isOpen,
  };
}

/**
 * Starts a timer that invokes `onFrame` with a fresh `mockHandState` at `intervalMs` cadence.
 * Returns a stop function.
 */
export function startMockHandStream(onFrame: (state: HandState) => void, intervalMs = 33): () => void {
  const start = Date.now();
  const timer = setInterval(() => {
    onFrame(mockHandState((Date.now() - start) / 1000));
  }, intervalMs);
  return () => clearInterval(timer);
}
