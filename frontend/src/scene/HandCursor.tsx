/**
 * 3D brush cursor rendered at the camera-ray hit point, colored/sized by EMG force with a
 * heat-glow emissive ramp (Task F).
 * @remarks Purely presentational — pass the `position`/`force` returned by `useFusion()`.
 * Mount inside the same `<Canvas>` as the rest of the scene.
 */
import { useMemo } from "react";
import { Color } from "three";
import { BRUSH_RADIUS } from "../contracts";

export interface HandCursorProps {
  position: [number, number, number];
  force: number;
}

/** Cool idle tint (low/no force) the cursor ramps up from. */
const COOL_COLOR = new Color("#7dd3fc");
/** Warm "hot clay" tint the cursor ramps toward as force approaches 1. */
const HOT_COLOR = new Color("#ff5a1f");

/** Renders the glowing brush sphere at the current hit point, scaled/colored by `force`. */
export default function HandCursor({ position, force }: HandCursorProps) {
  const clamped = Math.min(1, Math.max(0, force));
  const color = useMemo(() => COOL_COLOR.clone().lerp(HOT_COLOR, clamped), [clamped]);
  const radius = BRUSH_RADIUS * (0.35 + 0.65 * clamped);

  return (
    <mesh position={position} renderOrder={10}>
      <sphereGeometry args={[radius, 16, 16]} />
      <meshStandardMaterial
        color={color}
        emissive={color}
        emissiveIntensity={0.4 + clamped * 2.2}
        transparent
        opacity={0.55}
        depthWrite={false}
      />
    </mesh>
  );
}
