/**
 * Mounts the fusion loop inside the Canvas and renders the brush cursor at its result.
 * @remarks `useFusion` needs `useThree`/`useFrame`, so it must run from a component inside
 * `<Canvas>`; this is that component. Render it as a child of `Viewport`.
 */
import { useFusion } from "../control/useFusion";
import HandCursor from "./HandCursor";

export default function FusionLayer() {
  const frame = useFusion();
  return <HandCursor position={frame.position} force={frame.force} mode={frame.mode} />;
}
