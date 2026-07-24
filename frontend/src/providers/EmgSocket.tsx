/**
 * EMG WebSocket provider: receives `EmgMessage` pushes from `:6970` (~40Hz) and exposes the
 * latest reading plus calibration commands via an imperative getter API (Task C).
 */
import { createContext, useContext, useEffect, useMemo, useRef, type ReactNode } from "react";
import { EMG_WS } from "../contracts";
import type { EmgMessage } from "../contracts";

export interface EmgSocketApi {
  /** Returns the most recent `EmgMessage`, or null before the first push. */
  getData(): EmgMessage | null;
  getConnectionStatus(): "connecting" | "connected" | "disconnected";
  /** Sends `{"cmd":"calibrate_rest"}`. */
  calibrateRest(): void;
  /** Sends `{"cmd":"calibrate_max"}`. */
  calibrateMax(): void;
  /** Sends `{"cmd":"reset"}`. */
  reset(): void;
}

const EmgSocketContext = createContext<EmgSocketApi | null>(null);
const RECONNECT_MS = 3000;

/** Provides `EmgSocketApi` to descendants; owns the `:6970` WebSocket lifecycle (auto-reconnect every 3s). */
export function EmgSocketProvider({ children }: { children: ReactNode }) {
  const wsRef = useRef<WebSocket | null>(null);
  const dataRef = useRef<EmgMessage | null>(null);
  const statusRef = useRef<"connecting" | "connected" | "disconnected">("disconnected");
  const reconnectTimerRef = useRef<number | null>(null);

  const sendCmd = (cmd: "calibrate_rest" | "calibrate_max" | "reset") => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify({ cmd }));
  };

  useEffect(() => {
    let cancelled = false;

    const connect = () => {
      if (cancelled) return;
      const ws = new WebSocket(EMG_WS);
      wsRef.current = ws;
      statusRef.current = "connecting";

      ws.onopen = () => {
        statusRef.current = "connected";
      };
      ws.onclose = () => {
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
          dataRef.current = JSON.parse(text) as EmgMessage;
        } catch {
          // ignore malformed frames
        }
      };
    };

    connect();
    return () => {
      cancelled = true;
      if (reconnectTimerRef.current !== null) window.clearTimeout(reconnectTimerRef.current);
      wsRef.current?.close();
      wsRef.current = null;
    };
  }, []);

  const api = useMemo<EmgSocketApi>(
    () => ({
      getData: () => dataRef.current,
      getConnectionStatus: () => statusRef.current,
      calibrateRest: () => sendCmd("calibrate_rest"),
      calibrateMax: () => sendCmd("calibrate_max"),
      reset: () => sendCmd("reset"),
    }),
    [],
  );
  return <EmgSocketContext.Provider value={api}>{children}</EmgSocketContext.Provider>;
}

/** Reads the `EmgSocketApi` from context; throws if used outside `EmgSocketProvider`. */
export function useEmgSocket(): EmgSocketApi {
  const ctx = useContext(EmgSocketContext);
  if (!ctx) throw new Error("useEmgSocket must be used within an EmgSocketProvider");
  return ctx;
}
