/**
 * Breaks a held fragile object when the clench exceeds CRACK_FORCE.
 *
 * Reads EMG force straight from `useEmgSocket` rather than from `useFusionStatus`, because the
 * fusion loop zeroes `force` outside "warp" mode — so the status store reports 0 during a
 * carry, which is exactly when we need it.
 *
 * Purely additive: it watches the store and reacts, so it touches none of the grab/carry logic.
 */
import { useEffect, useRef } from "react";
import { useEmgSocket } from "../providers/EmgSocket";
import { useFusionStatus } from "../control/fusionStatus";
import { useEditor } from "../store/editor";
import { CRACK_FORCE, FRAGILE_PREFIX, makeShard } from "./fragileGeometry";

/** Shards produced when something cracks. */
const SHARDS = 9;
/** How far shards are flung from the break point (world units). */
const SCATTER = 0.28;

/** Mounted once, outside the Canvas. Renders nothing. */
export default function FragileWatcher() {
  const emg = useEmgSocket();
  /** Guards against breaking the same object twice while force stays above the threshold. */
  const broken = useRef<Set<string>>(new Set());

  useEffect(() => {
    const id = setInterval(() => {
      const force = emg.getData()?.force ?? 0;
      if (force < CRACK_FORCE) return;

      const heldId = useFusionStatus.getState().heldObjectId;
      if (!heldId || broken.current.has(heldId)) return;

      const store = useEditor.getState();
      const obj = store.objects.find((o) => o.id === heldId);
      if (!obj || !obj.name?.startsWith(FRAGILE_PREFIX)) return;

      broken.current.add(heldId);
      const [ox, oy, oz] = obj.position;

      // Scatter shards around where it broke, then remove the original.
      for (let i = 0; i < SHARDS; i++) {
        const a = (i / SHARDS) * Math.PI * 2;
        const r = SCATTER * (0.5 + 0.5 * ((i * 3) % 4) / 4);
        store.addObject({
          geometry: "custom",
          customGeometry: makeShard(0.13, i),
          name: `shard:${heldId}:${i}`,
          position: [ox + Math.cos(a) * r, oy + 0.1 * (i % 3), oz + Math.sin(a) * r],
          physics: "dynamic",
          material: {
            color: obj.material?.color ?? "#e8e0d0",
            metalness: 0.05,
            roughness: 0.85,
            emissive: "#000000",
            emissiveIntensity: 0,
          },
        });
      }

      store.select(heldId);
      store.deleteSelected();
      store.select(null);
    }, 60);
    return () => clearInterval(id);
  }, [emg]);

  return null;
}
