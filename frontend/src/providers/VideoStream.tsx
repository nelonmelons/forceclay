/**
 * Webcam capture provider: owns a hidden `getUserMedia` video element (640x360) and exposes
 * `captureFrame()` to draw a mirrored JPEG snapshot for the vision backend (Task C).
 */
import { createContext, useContext, useEffect, useRef, type ReactNode, type RefObject } from "react";

export interface VideoStreamApi {
  videoRef: RefObject<HTMLVideoElement | null>;
  /** Draws the current mirrored video frame to an offscreen canvas and returns a JPEG ArrayBuffer (quality ~0.5). */
  captureFrame(): Promise<ArrayBuffer | null>;
}

const VideoStreamContext = createContext<VideoStreamApi | null>(null);

const FRAME_WIDTH = 640;
const FRAME_HEIGHT = 360;

/** Provides `VideoStreamApi` to descendants; mounts a hidden `<video>` fed by `getUserMedia`. */
export function VideoStreamProvider({ children }: { children: ReactNode }) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    let stream: MediaStream | null = null;
    let cancelled = false;
    navigator.mediaDevices
      .getUserMedia({ video: { width: { ideal: FRAME_WIDTH }, height: { ideal: FRAME_HEIGHT } } })
      .then((s) => {
        if (cancelled) {
          s.getTracks().forEach((t) => t.stop());
          return;
        }
        stream = s;
        if (videoRef.current) {
          videoRef.current.srcObject = s;
          videoRef.current.play().catch(() => {});
        }
      })
      .catch((err) => console.error("VideoStreamProvider: getUserMedia failed", err));
    return () => {
      cancelled = true;
      stream?.getTracks().forEach((t) => t.stop());
    };
  }, []);

  const captureFrame = async (): Promise<ArrayBuffer | null> => {
    const video = videoRef.current;
    if (!video || video.readyState < video.HAVE_CURRENT_DATA) return null;
    if (!canvasRef.current) canvasRef.current = document.createElement("canvas");
    const canvas = canvasRef.current;
    canvas.width = FRAME_WIDTH;
    canvas.height = FRAME_HEIGHT;
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    // Mirror horizontally so the feed matches the user's real-world hand motion.
    ctx.setTransform(-1, 0, 0, 1, canvas.width, 0);
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    return new Promise((resolve) => {
      canvas.toBlob(
        (blob) => {
          if (!blob) return resolve(null);
          blob.arrayBuffer().then(resolve).catch(() => resolve(null));
        },
        "image/jpeg",
        0.5,
      );
    });
  };

  const api: VideoStreamApi = { videoRef, captureFrame };
  return (
    <VideoStreamContext.Provider value={api}>
      <video ref={videoRef} style={{ display: "none" }} muted playsInline />
      {children}
    </VideoStreamContext.Provider>
  );
}

/** Reads the `VideoStreamApi` from context; throws if used outside `VideoStreamProvider`. */
export function useVideoStream(): VideoStreamApi {
  const ctx = useContext(VideoStreamContext);
  if (!ctx) throw new Error("useVideoStream must be used within a VideoStreamProvider");
  return ctx;
}
