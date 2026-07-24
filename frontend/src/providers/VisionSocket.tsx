/**
 * Vision WebSocket provider: captures mirrored JPEG frames to `:6969/ws` and exposes the
 * latest `VisionMessage` via imperative getters (Task C).
 * @remarks Mirrors ShapeShift's `WebSocketContext` — request/response backpressure (only
 * send the next frame once the last result arrived), auto-reconnect every 3s.
 */
import { createContext, useContext, type ReactNode } from "react";
import type { VisionMessage } from "../contracts";

export interface VisionSocketApi {
  /** Sends one mirrored JPEG frame (ArrayBuffer) if the previous frame has been acknowledged. */
  sendFrame(jpeg: ArrayBuffer): void;
  /** Returns the most recent `VisionMessage`, or null before the first response. */
  getData(): VisionMessage | null;
  /** True once the last sent frame's response has arrived (backpressure gate). */
  getAcknowledged(): boolean;
  getConnectionStatus(): "connecting" | "connected" | "disconnected";
}

const VisionSocketContext = createContext<VisionSocketApi | null>(null);

/** Provides `VisionSocketApi` to descendants; owns the `:6969/ws` WebSocket lifecycle. */
export function VisionSocketProvider({ children }: { children: ReactNode }) {
  const api: VisionSocketApi = {
    sendFrame: () => {
      throw new Error("notImplemented: VisionSocketProvider.sendFrame");
    },
    getData: () => null,
    getAcknowledged: () => false,
    getConnectionStatus: () => "disconnected",
  };
  return <VisionSocketContext.Provider value={api}>{children}</VisionSocketContext.Provider>;
}

/** Reads the `VisionSocketApi` from context; throws if used outside `VisionSocketProvider`. */
export function useVisionSocket(): VisionSocketApi {
  const ctx = useContext(VisionSocketContext);
  if (!ctx) throw new Error("useVisionSocket must be used within a VisionSocketProvider");
  return ctx;
}
