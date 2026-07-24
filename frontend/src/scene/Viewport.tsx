/**
 * Root r3f `Canvas` for the single render path: camera, grid, lights, and scene contents
 * (Task C). Rapier physics and all sculpt/fusion consumers render inside this one Canvas.
 */
import { Canvas } from "@react-three/fiber";
import { Grid, PerspectiveCamera } from "@react-three/drei";
import type { ReactNode } from "react";
import { useEditor } from "../store/editor";
import ClayObject from "./ClayObject";

export interface ViewportProps {
  children?: ReactNode;
}

/**
 * The single r3f Canvas: PerspectiveCamera at (0,3,5) looking at the origin, Grid, lights,
 * every scene object rendered via `ClayObject`, and slot children (e.g. `HandCursor`, physics).
 */
export default function Viewport({ children }: ViewportProps) {
  const objects = useEditor((s) => s.objects);
  return (
    <Canvas>
      <PerspectiveCamera makeDefault position={[0, 3, 5]} fov={50} onUpdate={(c) => c.lookAt(0, 0, 0)} />
      <ambientLight intensity={0.6} />
      <directionalLight position={[5, 8, 5]} intensity={1} />
      <Grid args={[20, 20]} position={[0, 0, 0]} cellColor="#444" sectionColor="#888" fadeDistance={25} infiniteGrid />
      {objects.filter((o) => o.visible).map((o) => (
        <ClayObject key={o.id} object={o} />
      ))}
      {children}
    </Canvas>
  );
}
