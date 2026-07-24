/**
 * DOM overlay toolbar: one-active-at-a-time buttons for every `InteractionMode`, a divider,
 * add-shape buttons (box/sphere/cylinder/cone/torus), and undo/redo.
 * @remarks Pure `useEditor` consumer — `setInteractionMode`/`addObject`/`select`/`undo`/`redo`
 * are the only store actions it calls. Lives outside the Canvas alongside `ForceHUD`.
 */
import type { CSSProperties } from "react";
import { useEditor } from "../store/editor";
import type { GeometryKind, InteractionMode } from "../types";

const MODES: { mode: InteractionMode; label: string }[] = [
  { mode: "select", label: "Select" },
  { mode: "move", label: "Move" },
  { mode: "rotate", label: "Rotate" },
  { mode: "scale", label: "Scale" },
  { mode: "edit", label: "Edit" },
  { mode: "warp", label: "Warp" },
  { mode: "physics", label: "Physics" },
  { mode: "delete", label: "Delete" },
];

const SHAPES: { kind: GeometryKind; label: string }[] = [
  { kind: "box", label: "+ Box" },
  { kind: "sphere", label: "+ Sphere" },
  { kind: "cylinder", label: "+ Cylinder" },
  { kind: "cone", label: "+ Cone" },
  { kind: "torus", label: "+ Torus" },
];

/** Front-of-camera-ish spawn offset, staggered by object count so repeated adds don't fully overlap. */
function spawnPosition(count: number): [number, number, number] {
  const stagger = (count % 5) * 0.4 - 0.8;
  return [stagger, 2, -1];
}

function buttonStyle(active: boolean): CSSProperties {
  return {
    padding: "8px 12px",
    borderRadius: 8,
    border: active ? "1px solid #38bdf8" : "1px solid rgba(255,255,255,0.2)",
    background: active ? "rgba(56, 189, 248, 0.25)" : "rgba(15, 15, 20, 0.72)",
    color: "#fff",
    fontFamily: "system-ui, sans-serif",
    fontSize: 12,
    cursor: "pointer",
    backdropFilter: "blur(6px)",
  };
}

/** Fixed-position mode toolbar + add-shape buttons + undo/redo, for a stage demo. */
export default function Toolbar() {
  const objects = useEditor((s) => s.objects);
  const interactionMode = useEditor((s) => s.interactionMode);
  const setInteractionMode = useEditor((s) => s.setInteractionMode);
  const addObject = useEditor((s) => s.addObject);
  const select = useEditor((s) => s.select);
  const undo = useEditor((s) => s.undo);
  const redo = useEditor((s) => s.redo);

  const handleAdd = (kind: GeometryKind) => {
    const id = addObject({ geometry: kind, physics: "dynamic", position: spawnPosition(objects.length) });
    select(id);
  };

  return (
    <div
      style={{
        // Top-right; CalibrationPanel moved to bottom-center so this corner is now clear.
        position: "fixed",
        top: 16,
        right: 16,
        zIndex: 20,
        display: "flex",
        flexWrap: "wrap",
        gap: 6,
        maxWidth: 300,
        justifyContent: "flex-end",
      }}
    >
      {MODES.map(({ mode, label }) => (
        <button key={mode} style={buttonStyle(interactionMode === mode)} onClick={() => setInteractionMode(mode)}>
          {label}
        </button>
      ))}
      <div style={{ width: "100%", height: 0 }} />
      {SHAPES.map(({ kind, label }) => (
        <button key={kind} style={buttonStyle(false)} onClick={() => handleAdd(kind)}>
          {label}
        </button>
      ))}
      <div style={{ width: "100%", height: 0 }} />
      <button style={buttonStyle(false)} onClick={() => undo()}>
        Undo
      </button>
      <button style={buttonStyle(false)} onClick={() => redo()}>
        Redo
      </button>
    </div>
  );
}
