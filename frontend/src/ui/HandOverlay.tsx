/**
 * Full-screen transparent canvas that draws the MediaPipe hand skeleton from the vision
 * backend on top of the 3D scene.
 * @remarks Landmarks arrive in 640x360 pixel space already mirrored server-side (see
 * `VideoStream.captureFrame`), so they line up with the mirrored camera PIP without any
 * further mirroring here. We just scale by canvas.width/640 and canvas.height/360.
 */
import { useEffect, useRef } from "react";
import { useVisionSocket } from "../providers/VisionSocket";

const SOURCE_WIDTH = 640;
const SOURCE_HEIGHT = 360;

/** Renders hand skeletons (bones + landmark dots) as a fixed, pointer-events-none overlay. */
export default function HandOverlay() {
  const { getData } = useVisionSocket();
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const resize = () => {
      const dpr = window.devicePixelRatio || 1;
      canvas.width = window.innerWidth * dpr;
      canvas.height = window.innerHeight * dpr;
      canvas.style.width = `${window.innerWidth}px`;
      canvas.style.height = `${window.innerHeight}px`;
    };
    resize();
    window.addEventListener("resize", resize);

    let raf = 0;
    const draw = () => {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      const data = getData();
      if (data?.hands) {
        const scaleX = canvas.width / SOURCE_WIDTH;
        const scaleY = canvas.height / SOURCE_HEIGHT;
        for (const hand of data.hands) {
          ctx.strokeStyle = "#39ff88";
          ctx.lineWidth = 2;
          for (const [a, b] of hand.connections) {
            const p = hand.landmarks[a];
            const q = hand.landmarks[b];
            if (!p || !q) continue;
            ctx.beginPath();
            ctx.moveTo(p[0] * scaleX, p[1] * scaleY);
            ctx.lineTo(q[0] * scaleX, q[1] * scaleY);
            ctx.stroke();
          }
          ctx.fillStyle = "#ffffff";
          for (const [x, y] of hand.landmarks) {
            ctx.beginPath();
            ctx.arc(x * scaleX, y * scaleY, 4, 0, Math.PI * 2);
            ctx.fill();
          }
        }
      }
      raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);

    return () => {
      window.removeEventListener("resize", resize);
      cancelAnimationFrame(raf);
    };
  }, [getData]);

  return (
    <canvas
      ref={canvasRef}
      style={{
        position: "fixed",
        inset: 0,
        width: "100vw",
        height: "100vh",
        pointerEvents: "none",
        zIndex: 10,
      }}
    />
  );
}
