/**
 * Root r3f `Canvas` for the single render path: camera, grid, lights, and the physics-owned
 * scene contents (Task C, reconciled in Task G).
 * @remarks `PhysicsWorld` is the *single* owner of `SceneObject` rendering — it maps the store
 * to `<RigidBody>`-wrapped meshes for every object (fixed and dynamic alike). This component
 * must not also map/render `ClayObject` directly, or every object would draw twice.
 */
import { Canvas } from "@react-three/fiber";
import { Grid, OrbitControls, PerspectiveCamera } from "@react-three/drei";
import { useEffect } from "react";
import type { ReactNode } from "react";
import PhysicsWorld from "../physics/PhysicsWorld";
import { registerOrbitControls, setOrbitDisabled } from "./orbitControls";
import { useFusionStatus } from "../control/fusionStatus";
import { useEditor } from "../store/editor";
import DemoTable from "../fragile/DemoTable";

export interface ViewportProps {
  children?: ReactNode;
}

/**
 * Keeps mouse `OrbitControls` disabled while the hand is actively carrying (grabbed) or
 * warping (sculpting on a hit) an object, so hand-driven manipulation never fights camera
 * orbit. Mounted once inside the Canvas; renders nothing.
 * @remarks Gizmo/vertex-edit drags register their own "gizmo"/"vertex" reasons directly with
 * `orbitControls.ts`; this only owns the "hand" reason.
 */
function OrbitDisableOnHandActivity() {
  const heldObjectId = useFusionStatus((s) => s.heldObjectId);
  const interactionMode = useFusionStatus((s) => s.interactionMode);
  const hasHit = useFusionStatus((s) => s.hasHit);
  const busy = heldObjectId !== null || (interactionMode === "warp" && hasHit);
  useEffect(() => {
    setOrbitDisabled("hand", busy);
  }, [busy]);
  return null;
}

/**
 * The single r3f Canvas: PerspectiveCamera at (0,3,5) looking at the origin, mouse
 * `OrbitControls` for camera orbit/zoom, Grid, lights, `PhysicsWorld` (which renders every
 * scene object), and slot children (e.g. `HandCursor`, the fusion loop, the spawn-key
 * handler).
 * @remarks `OrbitControls` is camera-only — it does not render or own any `SceneObject`, so
 * adding it here does not violate `PhysicsWorld`'s "single owner of rendering" invariant. It is
 * disabled while a transform gizmo or vertex handle is dragging, or while the hand is carrying/
 * warping (see `scene/orbitControls.ts`), so mouse orbit never fights those interactions.
 * `onPointerMissed` deselects on empty-space clicks.
 */
export default function Viewport({ children }: ViewportProps) {
  return (
    <Canvas
      style={{ position: "fixed", inset: 0, width: "100vw", height: "100vh", display: "block" }}
      onPointerMissed={() => useEditor.getState().select(null)}
    >
      <color attach="background" args={["#f4f5f7"]} />
      <PerspectiveCamera makeDefault position={[0, 3, 5]} fov={50} onUpdate={(c) => c.lookAt(0, 0, 0)} />
      <OrbitControls makeDefault enableDamping ref={(instance) => registerOrbitControls(instance)} />
      {/* Flat, shadowless "playground" lighting: a bright ambient fill plus a soft hemisphere
          and a low-intensity directional (no castShadow) so shapes still read gentle form. */}
      <ambientLight intensity={0.9} />
      <hemisphereLight args={["#ffffff", "#dfe3ea", 0.6]} />
      <directionalLight position={[5, 8, 5]} intensity={0.35} />
      <Grid
        args={[20, 20]}
        position={[0, 0, 0]}
        cellColor="#d8dce3"
        sectionColor="#b9c0cc"
        fadeDistance={25}
        infiniteGrid
      />
      <PhysicsWorld>
        <DemoTable />
        {children}
      </PhysicsWorld>
      <OrbitDisableOnHandActivity />
    </Canvas>
  );
}
