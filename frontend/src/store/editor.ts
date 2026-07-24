/**
 * Zustand + immer scene store implementing `EditorStore` (Task C).
 * @remarks Undo/redo keeps deep-clone snapshots in module-level history stacks (mirrors
 * ShapeShift's `past`/`future`), pushed only on structural edits (add/delete/geometry) — not
 * on continuous transform/material drags, which would flood history every frame.
 */
import { create } from "zustand";
import { immer } from "zustand/middleware/immer";
import type { EditorStore, SceneObject } from "../types";

/** Clay-ish default material for newly spawned objects. */
function defaultMaterial() {
  return { color: "#c9986b", metalness: 0.05, roughness: 0.85, emissive: "#000000", emissiveIntensity: 0 };
}

interface Snapshot {
  objects: SceneObject[];
  selectedId: string | null;
}

function snapshot(objects: SceneObject[], selectedId: string | null): Snapshot {
  return { objects: JSON.parse(JSON.stringify(objects)), selectedId };
}

let past: Snapshot[] = [];
let future: Snapshot[] = [];

/** Primary scene-graph store. See `EditorStore` in `types.ts` for the full API. */
export const useEditor = create<EditorStore>()(
  immer((set, get) => ({
    objects: [],
    selectedId: null,
    interactionMode: "select",

    setInteractionMode: (m) =>
      set((state) => {
        state.interactionMode = m;
      }),

    addObject: (partial) => {
      const id = crypto.randomUUID();
      past.push(snapshot(get().objects, get().selectedId));
      future = [];
      set((state) => {
        state.objects.push({
          id,
          name: partial.name ?? partial.geometry,
          geometry: partial.geometry,
          geometryParams: partial.geometryParams,
          customGeometry: partial.customGeometry,
          position: partial.position ?? [0, 0, 0],
          rotation: partial.rotation ?? [0, 0, 0],
          scale: partial.scale ?? [1, 1, 1],
          material: { ...defaultMaterial(), ...partial.material },
          physics: partial.physics ?? "fixed",
          visible: partial.visible ?? true,
        });
        state.selectedId = id;
      });
      return id;
    },

    select: (id) =>
      set((state) => {
        state.selectedId = id;
      }),

    updateTransform: (id, t) =>
      set((state) => {
        const obj = state.objects.find((o) => o.id === id);
        if (!obj) return;
        if (t.position) obj.position = t.position;
        if (t.rotation) obj.rotation = t.rotation;
        if (t.scale) obj.scale = t.scale;
      }),

    updateGeometry: (id, geo) => {
      past.push(snapshot(get().objects, get().selectedId));
      future = [];
      set((state) => {
        const obj = state.objects.find((o) => o.id === id);
        if (!obj) return;
        obj.geometry = "custom";
        obj.customGeometry = geo;
      });
    },

    updateMaterial: (id, m) =>
      set((state) => {
        const obj = state.objects.find((o) => o.id === id);
        if (!obj) return;
        obj.material = { ...obj.material, ...m };
      }),

    setPhysics: (id, p) =>
      set((state) => {
        const obj = state.objects.find((o) => o.id === id);
        if (obj) obj.physics = p;
      }),

    deleteSelected: () => {
      const { selectedId, objects } = get();
      if (!selectedId) return;
      past.push(snapshot(objects, selectedId));
      future = [];
      set((state) => {
        state.objects = state.objects.filter((o) => o.id !== selectedId);
        state.selectedId = null;
      });
    },

    undo: () => {
      if (past.length === 0) return;
      const prev = past.pop()!;
      future.push(snapshot(get().objects, get().selectedId));
      set((state) => {
        state.objects = prev.objects;
        state.selectedId = prev.selectedId;
      });
    },

    redo: () => {
      if (future.length === 0) return;
      const next = future.pop()!;
      past.push(snapshot(get().objects, get().selectedId));
      set((state) => {
        state.objects = next.objects;
        state.selectedId = next.selectedId;
      });
    },
  })),
);
