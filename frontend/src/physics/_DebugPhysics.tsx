/**
 * Temporary manual smoke-test scene for Task E (physics). NOT part of the app — mount it
 * from `main.tsx` locally to verify `npm run dev`, then revert. Safe to delete.
 * @remarks Injects a dynamic sphere directly into the editor store via `setState` (bypassing
 * the still-stubbed `addObject` action from Task C) so grab/release/squash can be exercised
 * against a real `SceneObject` without depending on other in-progress tasks.
 */
import { RigidBody } from "@react-three/rapier";
import { useEffect } from "react";
import Viewport from "../scene/Viewport";
import { useEditor } from "../store/editor";
import PhysicsWorld, { grab, release, squash } from "./PhysicsWorld";

const DEBUG_ID = "debug-sphere";

function seedDebugScene(): void {
  useEditor.setState({
    objects: [
      {
        id: DEBUG_ID,
        name: "Debug Sphere",
        geometry: "sphere",
        geometryParams: { radius: 0.5 },
        position: [0, 5, 0],
        rotation: [0, 0, 0],
        scale: [1, 1, 1],
        material: { color: "#e07a5f", metalness: 0.1, roughness: 0.5, emissive: "#000000", emissiveIntensity: 0 },
        physics: "dynamic",
        visible: true,
      },
    ],
    selectedId: DEBUG_ID,
  });
}

/** Fixed floor for the dynamic sphere to fall onto and bounce. */
function Floor() {
  return (
    <RigidBody type="fixed" colliders="cuboid" position={[0, -0.5, 0]}>
      <mesh receiveShadow>
        <boxGeometry args={[10, 1, 10]} />
        <meshStandardMaterial color="#3a3a3a" />
      </mesh>
    </RigidBody>
  );
}

/** Dev-only debug scene: dynamic sphere + floor + grab/release buttons overlaid on the canvas. */
export default function DebugPhysicsScene() {
  useEffect(() => {
    seedDebugScene();
  }, []);

  return (
    <div style={{ position: "relative", width: "100vw", height: "100vh" }}>
      <Viewport>
        <PhysicsWorld>
          <Floor />
        </PhysicsWorld>
      </Viewport>
      <div style={{ position: "absolute", top: 16, left: 16, display: "flex", gap: 8 }}>
        <button onClick={() => grab(DEBUG_ID, [0, 2, 0])}>Grab (hold at [0,2,0])</button>
        <button onClick={() => release(DEBUG_ID, [0, 3, -4])}>Release (throw)</button>
        <button onClick={() => squash(DEBUG_ID, 0.8)}>Squash</button>
      </div>
    </div>
  );
}
