/**
 * 3D cursor rendered at the camera-ray hit point.
 * @remarks Purely presentational — pass the `position`/`force`/`mode` returned by
 * `useFusion()`. Mount inside the same `<Canvas>` as the rest of the scene. Only `"warp"`
 * mode uses the force-reactive heat-glow brush look (force is only meaningful there); every
 * other mode gets a small, fixed-size, calm marker so it isn't a distracting strobing sphere
 * while EMG force is unused.
 */
import { useMemo } from "react";
import { Color } from "three";
import { BRUSH_RADIUS } from "../contracts";
import type { InteractionMode } from "../types";

export interface HandCursorProps {
  position: [number, number, number];
  force: number;
  mode: InteractionMode;
}

/** Cool idle tint (low/no force) the warp brush ramps up from. */
const COOL_COLOR = new Color("#7dd3fc");
/** Warm "hot clay" tint the warp brush ramps toward as force approaches 1. */
const HOT_COLOR = new Color("#ff5a1f");
/** Fixed radius/opacity for the calm non-warp marker. */
const CALM_RADIUS = 0.05;
const CALM_OPACITY = 0.45;
const CALM_COLOR = new Color("#e2e8f0");

/** Renders the cursor at the current hit point: reactive brush in warp, calm dot otherwise. */
export default function HandCursor({ position, force, mode }: HandCursorProps) {
  const clamped = Math.min(1, Math.max(0, force));
  const brushColor = useMemo(() => COOL_COLOR.clone().lerp(HOT_COLOR, clamped), [clamped]);

  if (mode !== "warp") {
    return (
      <mesh position={position} renderOrder={10}>
        <sphereGeometry args={[CALM_RADIUS, 12, 12]} />
        <meshStandardMaterial color={CALM_COLOR} transparent opacity={CALM_OPACITY} depthWrite={false} />
      </mesh>
    );
  }

  const radius = BRUSH_RADIUS * (0.35 + 0.65 * clamped);
  return (
    <mesh position={position} renderOrder={10}>
      <sphereGeometry args={[radius, 16, 16]} />
      <meshStandardMaterial
        color={brushColor}
        emissive={brushColor}
        emissiveIntensity={0.4 + clamped * 2.2}
        transparent
        opacity={0.55}
        depthWrite={false}
      />
    </mesh>
  );
}
