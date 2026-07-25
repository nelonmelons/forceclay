/**
 * Full-screen transparent canvas that draws the MediaPipe hand skeleton from the vision
 * backend on top of the 3D scene.
 * @remarks Landmarks arrive in 640x360 pixel space already mirrored server-side (see
 * `VideoStream.captureFrame`), so they line up with the mirrored camera PIP without any
 * further mirroring here. We just scale by canvas.width/640 and canvas.height/360.
 */
import { useEffect, useRef } from "react";
import { useVisionSocket } from "../providers/VisionSocket";

/** Joint rows across the hand: tips, DIPs, PIPs, MCPs, then the wrist. Webbing connects along
 *  and between these rows to build the net. */
const JOINT_ROWS: number[][] = [
  [4, 8, 12, 16, 20],   // fingertips
  [3, 7, 11, 15, 19],   // DIP row
  [2, 6, 10, 14, 18],   // PIP row
  [1, 5, 9, 13, 17],    // MCP row
  [0, 0, 0, 0, 0],      // wrist (all rungs collapse to the wrist, fanning the palm)
];
/** Bold red bones, hot pink webbing, white-ringed joints — high contrast on a light scene. */
const BONE_COLOR = "#ff2d2d";
const WEB_COLOR = "#ff7a9c";
const JOINT_COLOR = "#ffffff";

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
          const line = (a: number, b: number) => {
            const p = hand.landmarks[a];
            const q = hand.landmarks[b];
            if (!p || !q) return;
            ctx.beginPath();
            ctx.moveTo(p[0] * scaleX, p[1] * scaleY);
            ctx.lineTo(q[0] * scaleX, q[1] * scaleY);
            ctx.stroke();
          };

          // Webbing first, underneath: rungs across the digits at each joint row turn the 20
          // skeleton bones into a net instead of five separate stick fingers.
          ctx.strokeStyle = WEB_COLOR;
          ctx.lineWidth = 1.6;
          for (const row of JOINT_ROWS) {
            for (let i = 0; i < row.length - 1; i++) line(row[i], row[i + 1]);
          }
          // Diagonals inside each row, so the mesh reads as a net rather than a ladder.
          for (let r = 0; r < JOINT_ROWS.length - 1; r++) {
            const a = JOINT_ROWS[r];
            const b = JOINT_ROWS[r + 1];
            for (let i = 0; i < Math.min(a.length, b.length) - 1; i++) {
              line(a[i], b[i + 1]);
              line(a[i + 1], b[i]);
            }
          }

          // Bones on top, bolder and brighter so the skeleton still dominates.
          ctx.strokeStyle = BONE_COLOR;
          ctx.lineWidth = 3.5;
          for (const [a, b] of hand.connections) line(a, b);

          ctx.fillStyle = JOINT_COLOR;
          ctx.strokeStyle = "#ffffff";
          ctx.lineWidth = 1.5;
          for (const [x, y] of hand.landmarks) {
            ctx.beginPath();
            ctx.arc(x * scaleX, y * scaleY, 5, 0, Math.PI * 2);
            ctx.fill();
            ctx.stroke();
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
