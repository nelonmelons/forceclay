/**
 * On-screen force meter + current fusion mode overlay (Task F).
 * @remarks Reads `useFusionStatus` (written every frame by `useFusion`, inside the Canvas)
 * so this plain DOM overlay can live *outside* the Canvas without prop drilling. Designed to
 * be legible from a few feet away for a stage demo.
 */
import { useFusionStatus } from "../control/useFusion";

const MODE_LABEL: Record<string, string> = {
  sculpt: "SCULPT",
  grab: "GRAB",
  smooth: "SMOOTH",
  spawn: "SPAWN",
  idle: "IDLE",
};

const MODE_COLOR: Record<string, string> = {
  sculpt: "#ff5a1f",
  grab: "#facc15",
  smooth: "#38bdf8",
  spawn: "#a78bfa",
  idle: "#6b7280",
};

/** Fixed-position force meter + mode/calibration readout for a stage demo. */
export default function ForceHUD() {
  const { mode, force, calibrated, connectionStatus } = useFusionStatus();
  const pct = Math.round(Math.min(1, Math.max(0, force)) * 100);
  const modeColor = MODE_COLOR[mode] ?? "#6b7280";

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
          {MODE_LABEL[mode] ?? mode.toUpperCase()}
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
    </div>
  );
}
