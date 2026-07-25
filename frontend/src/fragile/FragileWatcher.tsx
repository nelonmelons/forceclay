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
import { getBodyPosition, release } from "../physics/PhysicsWorld";
import { CRACK_FORCE, FRAGILE_PREFIX, makeShard, makeShell, makeYolk } from "./fragileGeometry";

/** Shards produced when something cracks. */
const SHARDS = 5;
/** Debris is cleared this long after a break so the scene does not fill with shells. */
const DEBRIS_TTL_MS = 5000;
/** Grace period after pickup before a squeeze can break anything. */
const SETTLE_MS = 250;
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
  /** Ids spawned by the last break, cleared after DEBRIS_TTL_MS. */
  const debris = useRef<string[]>([]);

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
      // Absolute threshold only. Requiring force > pickupForce + margin made cracking
      // unreachable whenever the grab itself already needed a firm clench: that sum could
      // exceed 1.0, so no squeeze could ever satisfy it and nothing ever broke.
      if (Date.now() - heldSince.current < SETTLE_MS) return;
      if (force < CRACK_FORCE) return;

      const store = useEditor.getState();
      const obj = store.objects.find((o) => o.id === heldId);
      if (!obj || !obj.name?.startsWith(FRAGILE_PREFIX)) return;

      broken.current.add(heldId);
      // Read the break point from the LIVE body, not obj.position: a carried object is driven
      // kinematically and the store transform lags behind where it visually is.
      const bp = getBodyPosition(heldId);
      const [ox, oy, oz] = bp ?? obj.position;

      // Destroy the original FIRST. It used to be deleted after the shell/yolk spawn, so any
      // throw in the geometry builders aborted the callback and left the egg intact -- the
      // "it turns into the cracked egg" step never happened. Releasing the grab first stops the
      // fusion loop driving a body that is about to vanish.
      try {
        release(heldId, [0, 0, 0]);
      } catch {
        // Not registered; nothing to release.
      }
      {
        const st = useEditor.getState();
        st.select(heldId);
        st.deleteSelected();
        st.select(null);
      }

      // Scatter shards around where it broke, then remove the original.
      const isEgg = obj.name === `${FRAGILE_PREFIX}egg`;
      const spawned: { id: string; a: number }[] = [];
      try {

      if (isEgg) {
        // Two shell halves peel apart and a yolk drops out — the literal read of "it cracks".
        for (const up of [true, false]) {
          const shellId = store.addObject({
            geometry: "custom",
            customGeometry: makeShell(0.42, up),
            name: `shard:${heldId}:shell${up ? "T" : "B"}`,
            position: [ox + (up ? 0.1 : -0.1), oy + (up ? 0.12 : -0.05), oz],
            physics: "dynamic",
            material: { color: "#f7efdd", metalness: 0.02, roughness: 0.55, emissive: "#000000", emissiveIntensity: 0 },
          });
          spawned.push({ id: shellId, a: up ? 0.5 : Math.PI + 0.5 });
        }
        const yolkId = store.addObject({
          geometry: "custom",
          customGeometry: makeYolk(0.2),
          name: `shard:${heldId}:yolk`,
          position: [ox, oy - 0.04, oz],
          physics: "dynamic",
          material: { color: "#ffb300", metalness: 0.0, roughness: 0.25, emissive: "#c26a00", emissiveIntensity: 0.55 },
        });
        // Nearly no lateral kick: the yolk should slump straight down, not fly.
        setTimeout(() => { try { release(yolkId, [0, -0.6, 0]); } catch { /* not registered */ } }, BURST_DELAY_MS);
        debris.current.push(yolkId);
      }
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

      // Fling the shards once Rapier has registered their bodies.
      } catch (e) {
        console.warn("[fragile] debris spawn failed", e);
      }
      for (const { id } of spawned) debris.current.push(id);
      // Clear the debris after a few seconds so repeated demos do not litter the scene.
      const toClear = debris.current.slice();
      debris.current = [];
      setTimeout(() => {
        const st = useEditor.getState();
        for (const id of toClear) {
          try { st.select(id); st.deleteSelected(); } catch { /* already gone */ }
        }
        st.select(null);
      }, DEBRIS_TTL_MS);

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
