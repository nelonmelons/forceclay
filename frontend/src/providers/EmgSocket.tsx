/**
 * EMG WebSocket provider: receives `EmgMessage` pushes from `:6970` (~40Hz) and exposes the
 * latest reading plus calibration commands via an imperative getter API (Task C).
 */
import { createContext, useContext, type ReactNode } from "react";
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

/** Provides `EmgSocketApi` to descendants; owns the `:6970` WebSocket lifecycle. */
export function EmgSocketProvider({ children }: { children: ReactNode }) {
  const api: EmgSocketApi = {
    getData: () => null,
    getConnectionStatus: () => "disconnected",
    calibrateRest: () => {
      throw new Error("notImplemented: EmgSocketProvider.calibrateRest");
    },
    calibrateMax: () => {
      throw new Error("notImplemented: EmgSocketProvider.calibrateMax");
    },
    reset: () => {
      throw new Error("notImplemented: EmgSocketProvider.reset");
    },
  };
  return <EmgSocketContext.Provider value={api}>{children}</EmgSocketContext.Provider>;
}

/** Reads the `EmgSocketApi` from context; throws if used outside `EmgSocketProvider`. */
export function useEmgSocket(): EmgSocketApi {
  const ctx = useContext(EmgSocketContext);
  if (!ctx) throw new Error("useEmgSocket must be used within an EmgSocketProvider");
  return ctx;
}
