/**
 * DOM overlay toolbar: one-active-at-a-time buttons for every `InteractionMode`, plus
 * undo/redo.
 * @remarks Pure `useEditor` consumer — `setInteractionMode`/`undo`/`redo` are the only store
 * actions it calls. Lives outside the Canvas alongside `ForceHUD`.
 */
import type { CSSProperties } from "react";
import { useEditor } from "../store/editor";
import type { InteractionMode } from "../types";

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

/** Fixed-position mode toolbar + undo/redo, for a stage demo. */
export default function Toolbar() {
  const interactionMode = useEditor((s) => s.interactionMode);
  const setInteractionMode = useEditor((s) => s.setInteractionMode);
  const undo = useEditor((s) => s.undo);
  const redo = useEditor((s) => s.redo);

  return (
    <div
      style={{
        position: "fixed",
        top: 16,
        right: 16,
        zIndex: 20,
        display: "flex",
        flexWrap: "wrap",
        gap: 6,
        maxWidth: 260,
        justifyContent: "flex-end",
      }}
    >
      {MODES.map(({ mode, label }) => (
        <button key={mode} style={buttonStyle(interactionMode === mode)} onClick={() => setInteractionMode(mode)}>
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
