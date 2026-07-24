/**
 * Triggers the rest + max-clench EMG calibration flow (Task F).
 * @remarks The EMG backend does the actual 3s rest / 3s max-clench sampling; this panel just
 * sequences the two commands and shows progress, flipping to "done" once
 * `EmgMessage.calibrated` turns true.
 */
import { useEffect, useRef, useState, type CSSProperties } from "react";
import { useEmgSocket } from "../providers/EmgSocket";

type Step = "idle" | "resting" | "clenching" | "done";

/** Roughly matches the backend's per-phase sampling window (see emg_server.py). */
const PHASE_MS = 3000;

/** Two-button rest/max calibration flow with a progress readout. */
export default function CalibrationPanel() {
  const emg = useEmgSocket();
  const [step, setStep] = useState<Step>("idle");
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => {
    if (timerRef.current) clearTimeout(timerRef.current);
  }, []);

  const runRest = () => {
    try {
      emg.calibrateRest();
      setStep("resting");
      timerRef.current = setTimeout(() => setStep("idle"), PHASE_MS);
    } catch {
      // Backend/socket not wired up yet; leave step as-is so the UI stays usable.
    }
  };

  const runMax = () => {
    try {
      emg.calibrateMax();
      setStep("clenching");
      timerRef.current = setTimeout(() => {
        setStep(emg.getData()?.calibrated ? "done" : "idle");
      }, PHASE_MS);
    } catch {
      // ignore — see runRest
    }
  };

  const reset = () => {
    try {
      emg.reset();
    } catch {
      // ignore
    }
    setStep("idle");
  };

  const calibrated = emg.getData()?.calibrated ?? false;
  const busy = step === "resting" || step === "clenching";

  return (
    <div
      style={{
        position: "fixed",
        top: 16,
        right: 16,
        zIndex: 20,
        padding: "12px 16px",
        borderRadius: 12,
        background: "rgba(15, 15, 20, 0.72)",
        color: "#fff",
        fontFamily: "system-ui, sans-serif",
        minWidth: 220,
        backdropFilter: "blur(6px)",
      }}
    >
      <div style={{ fontWeight: 700, fontSize: 13, letterSpacing: 1, marginBottom: 8 }}>CALIBRATION</div>
      <div style={{ display: "flex", gap: 8 }}>
        <button
          onClick={runRest}
          disabled={busy}
          style={buttonStyle(step === "resting")}
        >
          {step === "resting" ? "Hold relaxed…" : "1. Calibrate rest"}
        </button>
        <button
          onClick={runMax}
          disabled={busy}
          style={buttonStyle(step === "clenching")}
        >
          {step === "clenching" ? "Clench max…" : "2. Calibrate max"}
        </button>
      </div>
      <div style={{ display: "flex", justifyContent: "space-between", marginTop: 8, fontSize: 12 }}>
        <span style={{ opacity: 0.75 }}>{stepLabel(step)}</span>
        <button
          onClick={reset}
          style={{ background: "none", border: "none", color: "#93c5fd", cursor: "pointer", fontSize: 12, padding: 0 }}
        >
          reset
        </button>
      </div>
      <div style={{ marginTop: 4, fontSize: 12, color: calibrated ? "#4ade80" : "#f87171" }}>
        {calibrated ? "Session calibrated" : "Not calibrated"}
      </div>
    </div>
  );
}

function stepLabel(step: Step): string {
  switch (step) {
    case "resting":
      return "Sampling rest baseline…";
    case "clenching":
      return "Sampling max clench…";
    case "done":
      return "Calibration complete";
    default:
      return "Ready";
  }
}

function buttonStyle(active: boolean): CSSProperties {
  return {
    flex: 1,
    padding: "6px 10px",
    borderRadius: 8,
    border: "1px solid rgba(255,255,255,0.2)",
    background: active ? "#facc15" : "rgba(255,255,255,0.1)",
    color: active ? "#111" : "#fff",
    fontSize: 12,
    cursor: "pointer",
  };
}
