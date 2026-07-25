/**
 * Bursts a held prop when the clench passes its threshold: egg cracks, ketchup squirts, balloon
 * pops. Behaviour comes from `propCatalog.ts`, so this file stays generic — adding a prop needs
 * no change here.
 *
 * Reads EMG force straight from `useEmgSocket`, NOT from `useFusionStatus`, because the fusion
 * loop zeroes `force` outside "warp" mode — the status store reports 0 during a carry, which is
 * exactly when the squeeze check needs it.
 *
 * Purely additive: it watches the store and reacts, touching none of the grab/carry logic.
 */
import { useEffect, useRef } from "react";
import { useEmgSocket } from "../providers/EmgSocket";
import { useFusionStatus } from "../control/fusionStatus";
import { useEditor } from "../store/editor";
import { getBodyPosition, release } from "../physics/PhysicsWorld";
import { FRAGILE_PREFIX } from "./fragileGeometry";
import { findProp } from "./propCatalog";

/** Grace period after pickup before a squeeze can burst anything. */
const SETTLE_MS = 250;
/**
 * Delay before applying debris velocity. Rapier registers a body on mount, which happens on the
 * next React commit — applying velocity immediately hits an unregistered body and no-ops, so the
 * debris would drop straight down instead of bursting.
 */
const BURST_DELAY_MS = 60;
/** Debris is cleared this long after a burst so repeated demos do not litter the scene. */
const DEBRIS_TTL_MS = 5000;
/** A surviving prop (bottle, can) can be squeezed again after this long. */
const REARM_MS = 900;

/** Mounted once, outside the Canvas. Renders nothing. */
export default function FragileWatcher() {
  const emg = useEmgSocket();
  /** id -> when it last burst, so one squeeze does not fire on every tick. */
  const lastBurst = useRef<Map<string, number>>(new Map());
  const grabbedId = useRef<string | null>(null);
  const heldSince = useRef(0);

  useEffect(() => {
    const tick = setInterval(() => {
      const force = emg.getData()?.force ?? 0;
      const heldId = useFusionStatus.getState().heldObjectId;

      if (heldId !== grabbedId.current) {
        grabbedId.current = heldId;
        heldSince.current = heldId ? Date.now() : 0;
        return;
      }
      if (!heldId) return;
      if (Date.now() - heldSince.current < SETTLE_MS) return;

      const store = useEditor.getState();
      const obj = store.objects.find((o) => o.id === heldId);
      if (!obj?.name?.startsWith(FRAGILE_PREFIX)) return;
      const spec = findProp(obj.name.slice(FRAGILE_PREFIX.length));
      if (!spec) return;

      // NO per-tick material writes. The strain glow called updateMaterial every 60ms, which
      // mutates the store and forces every custom-geometry mesh to rebuild its BufferGeometry --
      // that was the lag. Not worth it for a colour ramp.
      if (force < spec.threshold) return;
      const last = lastBurst.current.get(heldId) ?? 0;
      if (Date.now() - last < REARM_MS) return;
      lastBurst.current.set(heldId, Date.now());

      // Burst point from the LIVE body: a carried object is driven kinematically, so the store
      // transform lags behind where it visually is and debris would spawn at a stale location.
      const bp = getBodyPosition(heldId);
      const [ox, oy, oz] = bp ?? obj.position;

      // Destroy a non-surviving prop FIRST, before anything that can throw. Deleting it after the
      // debris spawn meant a geometry failure aborted the callback and left the original intact.
      if (!spec.survives) {
        try {
          release(heldId, [0, 0, 0]);
        } catch {
          // Not registered; nothing to release.
        }
        const st = useEditor.getState();
        st.select(heldId);
        st.deleteSelected();
        st.select(null);
      }

      const spawned: { id: string; velocity: [number, number, number] }[] = [];
      try {
        const st = useEditor.getState();
        for (const d of spec.debris()) {
          const id = st.addObject({
            geometry: "custom",
            customGeometry: d.geometry,
            name: `debris:${spec.key}`,
            position: [ox + d.offset[0], oy + d.offset[1], oz + d.offset[2]],
            physics: "dynamic",
            material: d.material,
          });
          spawned.push({ id, velocity: d.velocity });
        }
      } catch (e) {
        console.warn("[fragile] debris spawn failed", e);
      }

      setTimeout(() => {
        for (const { id, velocity } of spawned) {
          try {
            release(id, velocity);
          } catch {
            // Body not registered yet, or already removed.
          }
        }
      }, BURST_DELAY_MS);

      setTimeout(() => {
        const st = useEditor.getState();
        for (const { id } of spawned) {
          try {
            st.select(id);
            st.deleteSelected();
          } catch {
            // Already removed.
          }
        }
        st.select(null);
      }, DEBRIS_TTL_MS);
    }, 60);
    return () => clearInterval(tick);
  }, [emg]);

  return null;
}
