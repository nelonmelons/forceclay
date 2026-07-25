/**
 * Spawn buttons for the two fragile demo props, plus a live crack-risk meter.
 *
 * The meter matters for the demo: without it, a break looks like a bug. Showing the clench
 * climbing toward the 85% line makes the cause legible before the egg goes.
 */
import { useEditor } from "../store/editor";
import { FRAGILE_PREFIX } from "./fragileGeometry";
import { PROPS } from "./propCatalog";

// Positioned by the top-right column wrapper in App.tsx — flows BELOW the toolbar, no overlap.
const PANEL: React.CSSProperties = {
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
  const spawn = (key: string) => {
    const spec = PROPS.find((p) => p.key === key);
    if (!spec) return;
    const id = addObject({
      geometry: "custom",
      // The `fragile:` prefix is what FragileWatcher keys off; clay and debris never burst.
      name: `${FRAGILE_PREFIX}${spec.key}`,
      customGeometry: spec.geometry(),
      position: spawnAt(objects.length),
      physics: "dynamic",
      material: spec.material,
    });
    select(id);
  };

  return (
    <div style={PANEL}>
      <div style={{ fontWeight: 700, fontSize: 12, letterSpacing: 1, marginBottom: 8 }}>FRAGILE</div>
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap", maxWidth: 240 }}>
        {PROPS.map((p) => (
          <button key={p.key} style={BTN} onClick={() => spawn(p.key)}>
            {p.label} <span style={{ opacity: 0.55 }}>{Math.round(p.threshold * 100)}%</span>
          </button>
        ))}
      </div>
    </div>
  );
}
