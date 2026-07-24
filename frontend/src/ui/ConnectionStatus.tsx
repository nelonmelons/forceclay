/**
 * Small fixed-position readout of camera / vision-backend / EMG-backend connection health.
 * @remarks All three sources are optional at runtime (no camera, backends not running) — this
 * is purely informational so the app is visibly usable in a degraded, hardware-less state.
 * Polls the providers' imperative getters on an interval since none of them re-render React.
 */
import { useEffect, useState } from "react";
import { useVideoStream } from "../providers/VideoStream";
import { useVisionSocket } from "../providers/VisionSocket";
import { useEmgSocket } from "../providers/EmgSocket";

function dotColor(state: "ok" | "pending" | "error"): string {
  if (state === "ok") return "#4ade80";
  if (state === "pending") return "#facc15";
  return "#f87171";
}

function Row({ label, state, text }: { label: string; state: "ok" | "pending" | "error"; text: string }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12 }}>
      <span
        style={{
          width: 8,
          height: 8,
          borderRadius: "50%",
          background: dotColor(state),
          boxShadow: `0 0 6px ${dotColor(state)}`,
          flexShrink: 0,
        }}
      />
      <span style={{ opacity: 0.85 }}>{label}</span>
      <span style={{ marginLeft: "auto", opacity: 0.6 }}>{text}</span>
    </div>
  );
}

/** Fixed bottom-left overlay: camera / vision :6969 / emg :6970 connection state. */
export default function ConnectionStatus() {
  const video = useVideoStream();
  const vision = useVisionSocket();
  const emg = useEmgSocket();
  const [, setTick] = useState(0);

  useEffect(() => {
    const id = window.setInterval(() => setTick((t) => t + 1), 250);
    return () => window.clearInterval(id);
  }, []);

  const cameraStatus = video.getStatus();
  const visionStatus = vision.getConnectionStatus();
  const emgStatus = emg.getConnectionStatus();
  const { sent, received } = vision.getStats();
  const handCount = vision.getData()?.hands?.length ?? 0;
  const insecureOrigin = !window.isSecureContext;
  const { readyState, hasSrc } = video.getVideoState();

  return (
    <div
      style={{
        position: "fixed",
        // Stacked directly above CameraPip (left:12, bottom:12, ~154px tall) with a small gap,
        // sharing its left edge and width so the two form one clean bottom-left column.
        bottom: 180,
        left: 12,
        width: 210,
        zIndex: 20,
        padding: "10px 12px",
        borderRadius: 12,
        background: "rgba(15, 15, 20, 0.72)",
        color: "#fff",
        fontFamily: "system-ui, sans-serif",
        boxSizing: "border-box",
        pointerEvents: "none",
        backdropFilter: "blur(6px)",
        display: "flex",
        flexDirection: "column",
        gap: 4,
      }}
    >
      <Row label="camera" state={cameraStatus === "ready" ? "ok" : cameraStatus === "pending" ? "pending" : "error"} text={cameraStatus} />
      <Row label="vision :6969" state={visionStatus === "connected" ? "ok" : visionStatus === "connecting" ? "pending" : "error"} text={visionStatus} />
      <Row label="emg :6970" state={emgStatus === "connected" ? "ok" : emgStatus === "connecting" ? "pending" : "error"} text={emgStatus} />
      <div style={{ fontSize: 11, opacity: 0.7, marginTop: 2 }}>
        frames: {sent}&rarr;{received}
      </div>
      <div style={{ fontSize: 11, opacity: 0.7 }}>hands: {handCount}</div>
      <div style={{ fontSize: 11, opacity: 0.7 }}>video: rs {readyState} src {hasSrc ? 1 : 0}</div>
      {cameraStatus === "error" && (
        <div style={{ fontSize: 11, color: "#f87171" }}>camera error — check OS/browser permission</div>
      )}
      {insecureOrigin && (
        <div style={{ fontSize: 11, color: "#f87171" }}>insecure origin — camera blocked; use localhost</div>
      )}
    </div>
  );
}
