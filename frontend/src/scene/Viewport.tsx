/**
 * Root r3f `Canvas` for the single render path: camera, grid, lights, and scene contents
 * (Task C). Rapier physics and all sculpt/fusion consumers render inside this one Canvas.
 */
import { Canvas } from "@react-three/fiber";
import type { ReactNode } from "react";

export interface ViewportProps {
  children?: ReactNode;
}

/** The single r3f Canvas: PerspectiveCamera at (0,3,5), Grid, lights, and scene children. */
export default function Viewport({ children }: ViewportProps) {
  return (
    <Canvas camera={{ position: [0, 3, 5], fov: 50 }}>
      <ambientLight intensity={0.6} />
      <directionalLight position={[5, 8, 5]} intensity={1} />
      {children}
    </Canvas>
  );
}
