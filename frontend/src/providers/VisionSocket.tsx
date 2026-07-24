/**
 * Vision WebSocket provider: captures mirrored JPEG frames to `:6969/ws` and exposes the
 * latest `VisionMessage` via imperative getters (Task C).
 * @remarks Mirrors ShapeShift's `WebSocketContext` — request/response backpressure (only
 * send the next frame once the last result arrived), auto-reconnect every 3s.
 */
import { createContext, useContext, useEffect, useMemo, useRef, type ReactNode } from "react";
import { VISION_WS } from "../contracts";
import type { VisionMessage } from "../contracts";
import { useVideoStream } from "./VideoStream";

export interface VisionSocketApi {
  /** Sends one mirrored JPEG frame (ArrayBuffer) if the previous frame has been acknowledged. */
  sendFrame(jpeg: ArrayBuffer): void;
  /** Returns the most recent `VisionMessage`, or null before the first response. */
  getData(): VisionMessage | null;
  /** True once the last sent frame's response has arrived (backpressure gate). */
  getAcknowledged(): boolean;
  getConnectionStatus(): "connecting" | "connected" | "disconnected";
  /** Diagnostic counters: frames sent to and messages received from the vision backend. */
  getStats(): { sent: number; received: number };
}

const VisionSocketContext = createContext<VisionSocketApi | null>(null);

const RECONNECT_MS = 3000;
/** If no message arrives for this long, assume the server dropped a frame silently and unblock sending. */
const WATCHDOG_MS = 2000;

/**
 * Provides `VisionSocketApi` to descendants; owns the `:6969/ws` WebSocket lifecycle and
 * drives a request/response capture loop via `requestAnimationFrame`.
 * @remarks Backpressure: the loop only calls `captureFrame`+send once `acknowledged` is true
 * (set on `onmessage`, cleared on send). A watchdog force-clears it if the server stalls.
 */
export function VisionSocketProvider({ children }: { children: ReactNode }) {
  const { captureFrame } = useVideoStream();
  const wsRef = useRef<WebSocket | null>(null);
  const dataRef = useRef<VisionMessage | null>(null);
  const acknowledgedRef = useRef(true);
  const statusRef = useRef<"connecting" | "connected" | "disconnected">("disconnected");
  const lastMessageAtRef = useRef(Date.now());
  const reconnectTimerRef = useRef<number | null>(null);
  /** Diagnostic-only counters (Task: pipeline troubleshooting); do not affect capture/send logic. */
  const sentCountRef = useRef(0);
  const receivedCountRef = useRef(0);

  const sendFrame = (jpeg: ArrayBuffer) => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(jpeg);
    acknowledgedRef.current = false;
    sentCountRef.current += 1;
  };

  useEffect(() => {
    let cancelled = false;

    const connect = () => {
      if (cancelled) return;
      const ws = new WebSocket(VISION_WS);
      wsRef.current = ws;
      statusRef.current = "connecting";

      ws.onopen = () => {
        // Re-assert this socket as current: a StrictMode double-mount can leave a stale
        // socket's onclose about to fire, so we must own wsRef here, not just at creation.
        if (cancelled) {
          ws.close();
          return;
        }
        wsRef.current = ws;
        statusRef.current = "connected";
      };
      ws.onclose = () => {
        // Ignore if a newer socket already superseded this one — otherwise a stale socket's
        // late onclose nulls out the live wsRef while status still reads "connected" (→ 0 frames).
        if (wsRef.current !== ws) return;
        statusRef.current = "disconnected";
        wsRef.current = null;
        if (!cancelled && reconnectTimerRef.current === null) {
          reconnectTimerRef.current = window.setTimeout(() => {
            reconnectTimerRef.current = null;
            connect();
          }, RECONNECT_MS);
        }
      };
      ws.onerror = () => ws.close();
      ws.onmessage = async (event) => {
        let text = "";
        if (typeof event.data === "string") text = event.data;
        else if (event.data instanceof Blob) text = await event.data.text();
        else return;
        try {
          const msg = JSON.parse(text) as VisionMessage;
          dataRef.current = msg;
          acknowledgedRef.current = true;
          lastMessageAtRef.current = Date.now();
          receivedCountRef.current += 1;
        } catch {
          // ignore malformed frames
        }
      };
    };

    connect();
    const watchdog = window.setInterval(() => {
      if (Date.now() - lastMessageAtRef.current > WATCHDOG_MS) acknowledgedRef.current = true;
    }, 500);

    return () => {
      cancelled = true;
      window.clearInterval(watchdog);
      if (reconnectTimerRef.current !== null) window.clearTimeout(reconnectTimerRef.current);
      wsRef.current?.close();
      wsRef.current = null;
    };
  }, []);

  useEffect(() => {
    let raf = 0;
    let stopped = false;
    const loop = async () => {
      if (stopped) return;
      const ws = wsRef.current;
      if (ws && ws.readyState === WebSocket.OPEN && acknowledgedRef.current) {
        const frame = await captureFrame();
        if (frame) sendFrame(frame);
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => {
      stopped = true;
      cancelAnimationFrame(raf);
    };
  }, [captureFrame]);

  const api = useMemo<VisionSocketApi>(
    () => ({
      sendFrame,
      getData: () => dataRef.current,
      getAcknowledged: () => acknowledgedRef.current,
      getConnectionStatus: () => statusRef.current,
      getStats: () => ({ sent: sentCountRef.current, received: receivedCountRef.current }),
    }),
    [],
  );
  return <VisionSocketContext.Provider value={api}>{children}</VisionSocketContext.Provider>;
}

/** Reads the `VisionSocketApi` from context; throws if used outside `VisionSocketProvider`. */
export function useVisionSocket(): VisionSocketApi {
  const ctx = useContext(VisionSocketContext);
  if (!ctx) throw new Error("useVisionSocket must be used within a VisionSocketProvider");
  return ctx;
}
