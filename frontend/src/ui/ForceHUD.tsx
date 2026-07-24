/**
 * On-screen force meter + current interaction-mode overlay (Task F).
 * @remarks Reads `useFusionStatus` (written every frame by `useFusion`, inside the Canvas)
 * so this plain DOM overlay can live *outside* the Canvas without prop drilling. Designed to
 * be legible from a few feet away for a stage demo.
 */
import { useEffect, useState } from "react";
import { useFusionStatus } from "../control/useFusion";
import { useEmgSocket } from "../providers/EmgSocket";

const MODE_LABEL: Record<string, string> = {
  select: "SELECT",
  move: "MOVE",
  rotate: "ROTATE",
  scale: "SCALE",
  edit: "EDIT",
  warp: "WARP",
  physics: "PHYSICS",
  delete: "DELETE",
};

const MODE_COLOR: Record<string, string> = {
  select: "#38bdf8",
  move: "#a78bfa",
  rotate: "#a78bfa",
  scale: "#a78bfa",
  edit: "#facc15",
  warp: "#ff5a1f",
  physics: "#4ade80",
  delete: "#f87171",
};

/** Fixed-position force meter + mode/calibration/hit-target-held readout for a stage demo. */
export default function ForceHUD() {
  const { interactionMode, calibrated, connectionStatus, hasHit, hoveredObjectId, heldObjectId, pinProgress, pinningId } =
    useFusionStatus();
  // Read EMG straight from the socket. useFusionStatus.force is zeroed outside "warp" mode, so
  // this meter sat at 0% during grab/carry and looked like the EMG stream was dead.
  const emg = useEmgSocket();
  const [force, setForce] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setForce(emg.getData()?.force ?? 0), 50);
    return () => clearInterval(id);
  }, [emg]);
  const pct = Math.round(Math.min(1, Math.max(0, force)) * 100);
  const modeColor = MODE_COLOR[interactionMode] ?? "#6b7280";

  return (
    <div
      style={{
        position: "fixed",
        top: 16,
        left: 16,
        zIndex: 20,
        padding: "12px 16px",
        borderRadius: 12,
        background: "rgba(15, 15, 20, 0.72)",
        color: "#fff",
        fontFamily: "system-ui, sans-serif",
        minWidth: 220,
        pointerEvents: "none",
        backdropFilter: "blur(6px)",
      }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
        <span
          style={{
            fontWeight: 700,
            letterSpacing: 1,
            fontSize: 14,
            color: modeColor,
            textShadow: `0 0 8px ${modeColor}`,
          }}
        >
          {MODE_LABEL[interactionMode] ?? interactionMode.toUpperCase()}
        </span>
        <span style={{ fontSize: 11, opacity: 0.7 }}>
          {connectionStatus === "connected" ? "EMG linked" : connectionStatus}
        </span>
      </div>

      <div
        style={{
          position: "relative",
          height: 14,
          borderRadius: 7,
          background: "rgba(255,255,255,0.12)",
          overflow: "hidden",
        }}
      >
        <div
          style={{
            position: "absolute",
            inset: 0,
            width: `${pct}%`,
            background: `linear-gradient(90deg, #38bdf8, ${modeColor})`,
            transition: "width 60ms linear",
          }}
        />
      </div>
      <div style={{ display: "flex", justifyContent: "space-between", marginTop: 6, fontSize: 12, opacity: 0.85 }}>
        <span>force {pct}%</span>
        <span style={{ color: calibrated ? "#4ade80" : "#f87171" }}>
          {calibrated ? "calibrated" : "not calibrated"}
        </span>
      </div>
      <div style={{ marginTop: 8, fontSize: 11, opacity: 0.7, lineHeight: 1.5 }}>
        <div>
          hit: {hasHit ? "yes" : "no"} · target: {hoveredObjectId ?? "-"} · held: {heldObjectId ?? "-"}
        </div>
        {pinningId && (
          <div style={{ color: "#4ade80" }}>Pinning… {Math.round(pinProgress * 100)}%</div>
        )}
      </div>
    </div>
  );
}
