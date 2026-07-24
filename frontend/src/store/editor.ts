/**
 * Zustand + immer scene store implementing `EditorStore` (Task C).
 * @remarks Stub for Task 0 — state shape is real (empty scene) so consumers can render
 * immediately; mutators throw until Task C implements them.
 */
import { create } from "zustand";
import { immer } from "zustand/middleware/immer";
import type { EditorStore } from "../types";

function notImplemented(name: string): never {
  throw new Error(`notImplemented: ${name}`);
}

/** Primary scene-graph store. See `EditorStore` in `types.ts` for the full API. */
export const useEditor = create<EditorStore>()(
  immer(() => ({
    objects: [],
    selectedId: null,
    addObject: () => notImplemented("editor.addObject"),
    select: () => notImplemented("editor.select"),
    updateTransform: () => notImplemented("editor.updateTransform"),
    updateGeometry: () => notImplemented("editor.updateGeometry"),
    updateMaterial: () => notImplemented("editor.updateMaterial"),
    setPhysics: () => notImplemented("editor.setPhysics"),
    deleteSelected: () => notImplemented("editor.deleteSelected"),
    undo: () => notImplemented("editor.undo"),
    redo: () => notImplemented("editor.redo"),
  })),
);
