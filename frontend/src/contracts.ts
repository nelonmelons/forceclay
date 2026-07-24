/**
 * Shared WebSocket message shapes and fusion constants for Force Clay.
 * @remarks Pinned contract (Task 0). Vision backend (:6969) and EMG backend (:6970) must
 * emit exactly these shapes; the frontend fusion controller depends on the constants below.
 */
// ---- Vision WS (:6969) server->client, mirrors ShapeShift ----

/** A single frame result from the vision backend. `dropped` when the 50ms frame budget is exceeded. */
export interface VisionMessage {
  status: "success" | "dropped";
  hands?: VisionHand[];
  image_size?: { width: number; height: number };
}

/** One detected hand: 21 MediaPipe landmarks in 640x360 pixel space plus skeleton edges. */
export interface VisionHand {
  handedness: "Left" | "Right";
  /** 21 x [x_px(0..640), y_px(0..360), z_rel]. */
  landmarks: [number, number, number][];
  connections: [number, number][];
}
// client->server: raw JPEG ArrayBuffer, quality ~0.5, mirrored, 640x360.

// ---- EMG WS (:6970) server->client, ~40Hz push ----

/** A normalized EMG force reading pushed by the EMG backend at ~40Hz. */
export interface EmgMessage {
  /** 0..1 normalized clench (primary signal). */
  force: number;
  /** 0..1 per electrode (visuals), length 8 or 16. */
  perChannel: number[];
  /** LDA-classified mode, stretch; may be absent (camera-pose fallback applies). */
  mode?: "sculpt" | "grab" | "smooth" | "spawn" | "idle";
  /** false until rest+max calibration has completed this session. */
  calibrated: boolean;
  /** 0..1 median-freq drop, stretch. */
  fatigue?: number;
}
// client->server (control): {"cmd":"calibrate_rest"} | {"cmd":"calibrate_max"} | {"cmd":"reset"}

// ---- Sculpt API (Task D) consumed by F ----
// applyBrush(geo, hitPointLocal, normalLocal, radius, force, dir): SerializableGeometry
//   dir: -1 press in, +1 pull out (taffy). Uses three-mesh-bvh for radius query.
// makeClaySphere(radius, detail): SerializableGeometry   // subdivided icosphere
// (Real declarations live in sculpt/brush.ts and sculpt/geometry.ts.)

// ---- Fusion constants ----

/** Vision backend WebSocket URL (mirrors ShapeShift's raw eventlet WS on :6969). */
export const VISION_WS = "ws://localhost:6969/ws";
/** EMG backend WebSocket URL (~40Hz push of EmgMessage). */
export const EMG_WS = "ws://localhost:6970";
/** Clench force above this threshold triggers a grab. */
export const GRAB_FORCE_ON = 0.45;
/** Clench force below this threshold triggers a release (hysteresis vs. GRAB_FORCE_ON). */
export const GRAB_FORCE_OFF = 0.25;
/** Default brush radius (world units) for sculpt queries. */
export const BRUSH_RADIUS = 0.4;
/** Default per-frame displacement scale applied in applyBrush. */
export const SCULPT_STRENGTH = 0.15;
