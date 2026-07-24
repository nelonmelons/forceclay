/**
 * Shared type definitions for Force Clay's frontend scene/store model.
 * @remarks This file is a pinned contract (Task 0) — every downstream task (A–F) imports
 * from here. Do not rename fields or types without re-syncing all consumers.
 */

/**
 * Fused per-frame state for a single hand, produced by `hands/useSkeleton.ts` from vision
 * landmarks.
 * @remarks `isPinching` (all-5-fingertip cluster) drives object grab/drag; `isHolding`
 * (thumb-index pinch) drives camera navigation. A hand can be both at once is not expected in
 * practice (the thresholds target different postures), but consumers should treat them as
 * independent booleans, matching ShapeShift.
 */
export interface HandInfo {
  /** Cursor position in 640x360 pixel space, EMA-smoothed (factor 0.2). */
  cursorPx: { x: number; y: number };
  /** Cursor position in normalized device coords (-1..1) for raycasting. */
  cursorNdc: { x: number; y: number };
  /** 1 - handDiagonal/canvasDiagonal; larger hand on screen = closer to camera. */
  depthProxy: number;
  /** All five fingertips clustered near their centroid (< 0.3*handSpread) — grab/drag gesture. */
  isPinching: boolean;
  /** Fingertips spread wide from their centroid (> 0.45*handSpread) — open-hand pose. */
  isOpen: boolean;
  /** Thumb-index tip distance < 0.25*handSpread, stable ~50ms — camera-navigation gesture. */
  isHolding: boolean;
  /** Hand roll (radians): angle of the wrist(0)->middle-finger-MCP(9) vector, EMA-smoothed and
   *  wraparound-safe. Drives pinch-to-rotate (twist) in `"rotate"` mode. */
  roll: number;
}

/** Per-frame state for both hands, keyed by MediaPipe `handedness`. Either side may be absent. */
export interface TwoHandState {
  left: HandInfo | null;
  right: HandInfo | null;
}

/** Supported primitive/geometry kinds a `SceneObject` may hold. */
export type GeometryKind = "box" | "sphere" | "cylinder" | "cone" | "torus" | "plane" | "custom";

/**
 * The single source of truth for what user interaction currently does to the scene.
 * @remarks All input consumers (fusion loop, gizmo, vertex handles, delete-hover) branch off
 * this one value — there is no separate "transformMode"/"editorMode" concept.
 */
export type InteractionMode = "select" | "move" | "rotate" | "scale" | "edit" | "warp" | "physics" | "delete";

/** Flat, JSON-serializable mesh buffers used for deformed ("custom") clay geometry. */
export interface SerializableGeometry {
  positions: number[];
  indices: number[];
  normals: number[];
}

/** A single object in the editable scene — mirrors ShapeShift's `SceneObject` shape. */
export interface SceneObject {
  id: string;
  name: string;
  geometry: GeometryKind;
  geometryParams?: Record<string, number>;
  /** Present when geometry === "custom" (e.g. sculpted clay). */
  customGeometry?: SerializableGeometry;
  position: [number, number, number];
  rotation: [number, number, number];
  scale: [number, number, number];
  material: { color: string; metalness: number; roughness: number; emissive: string; emissiveIntensity: number };
  /** "fixed" while sculpting (no physics body); "dynamic" once dropped into the physics world. */
  physics: "fixed" | "dynamic";
  visible: boolean;
}

/**
 * Zustand store API for the scene graph (Task C implements; D/E/F consume).
 * @remarks Mutations are expected to go through immer producers internally.
 */
export interface EditorStore {
  objects: SceneObject[];
  selectedId: string | null;
  /** The current global interaction mode; see `InteractionMode`. Defaults to "select". */
  interactionMode: InteractionMode;
  setInteractionMode(m: InteractionMode): void;
  /** Adds a new object to the scene and returns its generated id. */
  addObject(partial: Partial<SceneObject> & { geometry: GeometryKind }): string;
  select(id: string | null): void;
  updateTransform(id: string, t: Partial<Pick<SceneObject, "position" | "rotation" | "scale">>): void;
  updateGeometry(id: string, geo: SerializableGeometry): void;
  updateMaterial(id: string, m: Partial<SceneObject["material"]>): void;
  setPhysics(id: string, p: "fixed" | "dynamic"): void;
  deleteSelected(): void;
  undo(): void;
  redo(): void;
}
