/**
 * Spawn buttons for the two fragile demo props, plus a live crack-risk meter.
 *
 * The meter matters for the demo: without it, a break looks like a bug. Showing the clench
 * climbing toward the 85% line makes the cause legible before the egg goes.
 */
import { useEffect, useState } from "react";
import { useEmgSocket } from "../providers/EmgSocket";
import { useEditor } from "../store/editor";
import { CRACK_FORCE, FRAGILE_PREFIX, makeEgg, makeWillow } from "./fragileGeometry";

const PANEL: React.CSSProperties = {
  position: "fixed", bottom: 16, left: 16, zIndex: 20,
  padding: "12px 14px", borderRadius: 12, minWidth: 210,
  background: "rgba(15,15,20,0.72)", color: "#fff",
  fontFamily: "system-ui, sans-serif", backdropFilter: "blur(6px)",
};

const BTN: React.CSSProperties = {
  padding: "8px 12px", borderRadius: 9, cursor: "pointer", fontSize: 12,
  border: "1px solid rgba(255,255,255,0.2)", background: "rgba(255,255,255,0.08)", color: "#fff",
};

/** Fragile props spawn in front of the origin so they are immediately reachable. */
function spawnAt(i: number): [number, number, number] {
  return [(i % 3) * 0.9 - 0.9, 1.1, -0.3];
}

export default function FragileSpawnButtons() {
  const addObject = useEditor((s) => s.addObject);
  const select = useEditor((s) => s.select);
  const objects = useEditor((s) => s.objects);
  const emg = useEmgSocket();
  const [force, setForce] = useState(0);

  useEffect(() => {
    const id = setInterval(() => setForce(emg.getData()?.force ?? 0), 80);
    return () => clearInterval(id);
  }, [emg]);

  const spawn = (kind: "egg" | "willow") => {
    const id = addObject({
      geometry: "custom",
      // The `fragile:` name prefix is what FragileWatcher keys off — clay and shards are not
      // breakable, only things spawned through here.
      name: `${FRAGILE_PREFIX}${kind}`,
      customGeometry: kind === "egg" ? makeEgg(0.42) : makeWillow(0.62),
      position: spawnAt(objects.length),
      physics: "dynamic",
      material:
        kind === "egg"
          ? { color: "#f2e6d0", metalness: 0.05, roughness: 0.45, emissive: "#000000", emissiveIntensity: 0 }
          : { color: "#cfe8c8", metalness: 0.0, roughness: 0.7, emissive: "#1a2a12", emissiveIntensity: 0.25 },
    });
    select(id);
  };

  const risk = Math.min(force / CRACK_FORCE, 1);
  const danger = force >= CRACK_FORCE;

  return (
    <div style={PANEL}>
      <div style={{ fontWeight: 700, fontSize: 12, letterSpacing: 1, marginBottom: 8 }}>FRAGILE</div>
      <div style={{ display: "flex", gap: 8, marginBottom: 10 }}>
        <button style={BTN} onClick={() => spawn("egg")}>Egg</button>
        <button style={BTN} onClick={() => spawn("willow")}>One-wish willow</button>
      </div>
      <div style={{ fontSize: 11, opacity: 0.75, marginBottom: 4 }}>
        {danger ? "CRACKING" : `crack at ${Math.round(CRACK_FORCE * 100)}% clench`}
      </div>
      <div style={{ height: 7, borderRadius: 4, background: "rgba(255,255,255,0.14)", overflow: "hidden" }}>
        <div
          style={{
            height: "100%", width: `${risk * 100}%`,
            background: danger ? "#ff3b30" : risk > 0.75 ? "#ffb454" : "#7dd3fc",
            transition: "width 80ms linear",
          }}
        />
      </div>
    </div>
  );
}
