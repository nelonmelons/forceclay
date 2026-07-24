/**
 * Webcam capture provider: owns a hidden `getUserMedia` video element (640x360) and exposes
 * `captureFrame()` to draw a mirrored JPEG snapshot for the vision backend (Task C).
 */
import { createContext, useContext, useRef, type ReactNode, type RefObject } from "react";

export interface VideoStreamApi {
  videoRef: RefObject<HTMLVideoElement | null>;
  /** Draws the current mirrored video frame to an offscreen canvas and returns a JPEG ArrayBuffer (quality ~0.5). */
  captureFrame(): Promise<ArrayBuffer | null>;
}

const VideoStreamContext = createContext<VideoStreamApi | null>(null);

/** Provides `VideoStreamApi` to descendants; mounts a hidden `<video>` fed by `getUserMedia`. */
export function VideoStreamProvider({ children }: { children: ReactNode }) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const api: VideoStreamApi = {
    videoRef,
    captureFrame: async () => {
      throw new Error("notImplemented: VideoStreamProvider.captureFrame");
    },
  };
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
