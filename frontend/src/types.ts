/**
 * Shared type definitions for Force Clay's frontend scene/store model.
 * @remarks This file is a pinned contract (Task 0) — every downstream task (A–F) imports
 * from here. Do not rename fields or types without re-syncing all consumers.
 */

/** Fused per-frame hand state produced by `hands/useSkeleton.ts` from vision landmarks. */
export interface HandState {
  present: boolean;
  /** Cursor position in 640x360 pixel space, EMA-smoothed (factor 0.2). */
  cursorPx: { x: number; y: number };
  /** Cursor position in normalized device coords (-1..1) for raycasting. */
  cursorNdc: { x: number; y: number };
  /** 1 - handDiagonal/canvasDiagonal; larger hand on screen = closer to camera. */
  depthProxy: number;
  isPinching: boolean;
  isOpen: boolean;
  /** Hand roll angle (radians) from wrist->middle-MCP, for twist-to-rotate while carrying. */
  handAngle: number;
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
