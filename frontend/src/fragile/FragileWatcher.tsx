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
import { release } from "../physics/PhysicsWorld";
import { CRACK_FORCE, FRAGILE_PREFIX, makeShard } from "./fragileGeometry";

/** Shards produced when something cracks. */
const SHARDS = 9;
/** Grace period after pickup before a squeeze can break anything. */
const SETTLE_MS = 350;
/** Extra clench above the pickup force required to crack. */
const SQUEEZE_MARGIN = 0.12;
/** How far shards are flung from the break point (world units). */
const SCATTER = 0.28;
/** Outward speed given to each shard, units/sec. */
const BURST_SPEED = 3.2;
/** Upward kick so shards arc rather than sliding along the floor. */
const BURST_LIFT = 2.4;
/**
 * Delay before flinging shards. Rapier registers a body on mount, which happens on the next
 * React commit -- applying velocity immediately would hit an unregistered body and no-op, so
 * the shards would just drop straight down instead of bursting.
 */
const BURST_DELAY_MS = 60;

/** Mounted once, outside the Canvas. Renders nothing. */
export default function FragileWatcher() {
  const emg = useEmgSocket();
  /** Guards against breaking the same object twice while force stays above the threshold. */
  const broken = useRef<Set<string>>(new Set());
  /** Force sampled when the current object was first picked up. */
  const grabForce = useRef<number | null>(null);
  const grabbedId = useRef<string | null>(null);
  const heldSince = useRef(0);

  useEffect(() => {
    const id = setInterval(() => {
      const force = emg.getData()?.force ?? 0;
      const heldId = useFusionStatus.getState().heldObjectId;

      // Track pickup: remember the force it took to grab, and when.
      if (heldId !== grabbedId.current) {
        grabbedId.current = heldId;
        grabForce.current = heldId ? force : null;
        heldSince.current = heldId ? Date.now() : 0;
        return;
      }
      if (!heldId || broken.current.has(heldId)) return;

      // Strain glow: ramp the object's emissive as the squeeze approaches the crack point, so
      // the break is telegraphed instead of arriving out of nowhere.
      {
        const st = useEditor.getState();
        const o = st.objects.find((x) => x.id === heldId);
        if (o?.name?.startsWith(FRAGILE_PREFIX)) {
          const base = grabForce.current ?? 0;
          const strain = Math.min(Math.max((force - base) / Math.max(CRACK_FORCE - base, 1e-3), 0), 1);
          st.updateMaterial(heldId, {
            emissive: strain > 0.05 ? "#ff3b1f" : "#000000",
            emissiveIntensity: strain * 1.6,
          });
        }
      }

      // Cracking needs a deliberate EXTRA squeeze, not the force that picked it up. Comparing
      // against an absolute threshold broke the egg the instant it was grabbed, because the
      // grab force already exceeded it -- so it could never be held at all.
      if (Date.now() - heldSince.current < SETTLE_MS) return;
      const base = grabForce.current ?? 0;
      if (force < CRACK_FORCE || force < base + SQUEEZE_MARGIN) return;

      const store = useEditor.getState();
      const obj = store.objects.find((o) => o.id === heldId);
      if (!obj || !obj.name?.startsWith(FRAGILE_PREFIX)) return;

      broken.current.add(heldId);
      const [ox, oy, oz] = obj.position;

      // Scatter shards around where it broke, then remove the original.
      const spawned: { id: string; a: number }[] = [];
      for (let i = 0; i < SHARDS; i++) {
        const a = (i / SHARDS) * Math.PI * 2;
        const r = SCATTER * (0.5 + 0.5 * ((i * 3) % 4) / 4);
        const shardId = store.addObject({
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
        spawned.push({ id: shardId, a });
      }

      store.select(heldId);
      store.deleteSelected();
      store.select(null);

      // Fling the shards once Rapier has registered their bodies.
      setTimeout(() => {
        for (const { id, a } of spawned) {
          try {
            release(id, [Math.cos(a) * BURST_SPEED, BURST_LIFT, Math.sin(a) * BURST_SPEED]);
          } catch {
            // Body not registered (object already removed) -- nothing to fling.
          }
        }
      }, BURST_DELAY_MS);
    }, 60);
    return () => clearInterval(id);
  }, [emg]);

  return null;
}
