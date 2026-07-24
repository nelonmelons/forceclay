/**
 * Per-frame fusion controller: reads `HandState` + `EmgMessage`, raycasts camera->cursor to
 * a surface hit, and dispatches sculpt/grab/smooth actions by mode (Task F).
 * @remarks Camera-pose fallback when no confident LDA mode is present: open=sculpt,
 * pinch=grab, palm=smooth. Grab uses `GRAB_FORCE_ON`/`GRAB_FORCE_OFF` hysteresis.
 */

/** Runs the fusion loop; call once per frame (e.g. inside `useFrame`). */
export function useFusion(): void {
  throw new Error("notImplemented: useFusion");
}
