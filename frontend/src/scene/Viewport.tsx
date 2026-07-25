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

/** Sky background color, shared with `fog` (see `Viewport`) so the horizon fade is seamless. */
const SKY_COLOR = "#a9ccef";
/** Floor color: kept WHITE (not sky-tinted) so the ground reads as a distinct surface from the
 *  blue sky — only fog fades it toward `SKY_COLOR` far in the distance. */
const GROUND_COLOR = "#ffffff";

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
 * `onPointerMissed` deselects on empty-space clicks. The sky-blue background, `fog`, and the
 * `Grid`'s fade share the SAME color/falloff so the horizon dissolves seamlessly instead of
 * cutting off into a flat wall, and the camera's far plane is pushed out to match so distant
 * geometry isn't clipped before it has a chance to fade.
 * @remarks Ground stays WHITE, not sky-blue: `Grid` itself is a mostly-transparent shader (its
 * "background" is whatever's behind it), so a solid white ground plane sits just beneath it to
 * give the floor an opaque white base; the fog's `near` is kept far enough out that this base
 * reads crisp white up close and only fades toward `SKY_COLOR` near the horizon, matching the
 * `Grid`'s own fade. The plane disables raycasting so it can't be picked up as a hover/grab
 * target or shadow the existing hit-test behavior.
 */
export default function Viewport({ children }: ViewportProps) {
  return (
    <Canvas
      style={{ position: "fixed", inset: 0, width: "100vw", height: "100vh", display: "block" }}
      onPointerMissed={() => useEditor.getState().select(null)}
    >
      <color attach="background" args={[SKY_COLOR]} />
      {/* Distance fog fades far geometry into the same sky color as the background so "seeing
          into infinity" reads as an airy dissolve rather than an abrupt clip. `near` is pushed
          out past the near/mid ground so the white floor stays white up close — only the far
          field (out past the Grid's own fadeDistance below) washes to sky blue. */}
      <fog attach="fog" args={[SKY_COLOR, 30, 150]} />
      <PerspectiveCamera
        makeDefault
        position={[0, 3, 5]}
        fov={50}
        far={1000}
        onUpdate={(c) => c.lookAt(0, 0, 0)}
      />
      <OrbitControls makeDefault enableDamping ref={(instance) => registerOrbitControls(instance)} />
      {/* Shadowless "playground" lighting, tuned for a bit more form/definition than a flat
          wash: a softer ambient fill, a brighter hemisphere for open-air color bounce, a
          stronger key directional light, and a dim cool rim/fill from the opposite side so
          shapes pick up a gentle gradient without blowing out their pastel fills. */}
      <ambientLight intensity={0.55} />
      <hemisphereLight args={["#ffffff", "#dfe3ea", 0.7]} />
      <directionalLight position={[5, 8, 5]} intensity={0.55} />
      <directionalLight position={[-6, 3, -4]} intensity={0.18} color="#bcdcf5" />
      {/* Solid white ground plane: `Grid` below is mostly transparent (a shader-drawn line
          pattern), so without an opaque base behind it the "floor" was reading as the same blue
          as the background. This plane gives it a real white surface; fog still fades it toward
          `SKY_COLOR` far in the distance. Not raycastable, so hover/grab targeting is unaffected. */}
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -0.02, 0]} raycast={() => null}>
        <planeGeometry args={[400, 400]} />
        <meshBasicMaterial color={GROUND_COLOR} fog />
      </mesh>
      <Grid
        args={[20, 20]}
        position={[0, 0, 0]}
        cellColor="#d8dce3"
        sectionColor="#b9c0cc"
        fadeDistance={120}
        fadeStrength={1.2}
        infiniteGrid
      />
      <PhysicsWorld>{children}</PhysicsWorld>
      <OrbitDisableOnHandActivity />
    </Canvas>
  );
}
