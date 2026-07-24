/**
 * Root r3f `Canvas` for the single render path: camera, grid, lights, and the physics-owned
 * scene contents (Task C, reconciled in Task G).
 * @remarks `PhysicsWorld` is the *single* owner of `SceneObject` rendering — it maps the store
 * to `<RigidBody>`-wrapped meshes for every object (fixed and dynamic alike). This component
 * must not also map/render `ClayObject` directly, or every object would draw twice.
 */
import { Canvas } from "@react-three/fiber";
import { Grid, PerspectiveCamera } from "@react-three/drei";
import type { ReactNode } from "react";
import PhysicsWorld from "../physics/PhysicsWorld";

export interface ViewportProps {
  children?: ReactNode;
}

/**
 * The single r3f Canvas: PerspectiveCamera at (0,3,5) looking at the origin, Grid, lights,
 * `PhysicsWorld` (which renders every scene object), and slot children (e.g. `HandCursor`,
 * the fusion loop, the spawn-key handler).
 */
export default function Viewport({ children }: ViewportProps) {
  return (
    <Canvas shadows>
      <PerspectiveCamera makeDefault position={[0, 3, 5]} fov={50} onUpdate={(c) => c.lookAt(0, 0, 0)} />
      <ambientLight intensity={0.6} />
      <directionalLight position={[5, 8, 5]} intensity={1} castShadow />
      <Grid args={[20, 20]} position={[0, 0, 0]} cellColor="#444" sectionColor="#888" fadeDistance={25} infiniteGrid />
      <PhysicsWorld>{children}</PhysicsWorld>
    </Canvas>
  );
}
