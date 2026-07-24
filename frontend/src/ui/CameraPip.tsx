/**
 * Visible camera preview, bottom-left, mirrored to match the user's real-world motion.
 * @remarks Port of ShapeShift's `components/VideoStream.tsx` layout, rewritten with plain
 * inline styles (no styled-components). Binds its own `<video>` to the shared
 * `getStream()` MediaStream — re-attaching whenever the stream reference changes, since the
 * hidden capture `<video>` in `VideoStreamProvider` owns the original element.
 */
import { useEffect, useRef, useState } from "react";
import { useVideoStream } from "../providers/VideoStream";

/** Bottom-left camera PIP card showing the live mirrored feed and connection status. */
export default function CameraPip() {
  const { getStatus, getStream } = useVideoStream();
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [status, setStatus] = useState<"pending" | "ready" | "error">("pending");

  useEffect(() => {
    const attached = { current: null as MediaStream | null };
    const interval = window.setInterval(() => {
      setStatus(getStatus());
      const stream = getStream();
      if (stream && attached.current !== stream && videoRef.current) {
        videoRef.current.srcObject = stream;
        videoRef.current.play().catch(() => {});
        attached.current = stream;
      }
    }, 250);
    return () => window.clearInterval(interval);
  }, [getStatus, getStream]);

  return (
    <div
      style={{
        position: "fixed",
        left: 12,
        bottom: 12,
        width: 210,
        zIndex: 15,
        background: "rgba(18, 20, 26, 0.85)",
        border: "1px solid rgba(255,255,255,0.08)",
        borderRadius: 8,
        padding: 6,
        display: "flex",
        flexDirection: "column",
        gap: 4,
      }}
    >
      <video
        ref={videoRef}
        autoPlay
        muted
        playsInline
        style={{
          width: "100%",
          height: 120,
          background: "#0f1116",
          borderRadius: 6,
          transform: "scaleX(-1)",
          objectFit: "cover",
          border: "1px solid rgba(255,255,255,0.06)",
        }}
      />
      <div
        style={{
          fontSize: 10,
          color: "#8c8c8c",
          background: "rgba(0,0,0,0.3)",
          padding: "3px 6px",
          borderRadius: 4,
          textAlign: "center",
          border: "1px solid rgba(255,255,255,0.04)",
        }}
      >
        {status}
      </div>
    </div>
  );
}
