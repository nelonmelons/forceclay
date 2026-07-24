/**
 * 3D brush cursor rendered at the camera-ray hit point, colored/sized by EMG force with a
 * heat-glow emissive ramp (Task F).
 */
export interface HandCursorProps {
  position: [number, number, number];
  force: number;
}

/** Renders the glowing brush sphere at the current hit point, scaled/colored by `force`. */
export default function HandCursor(_props: HandCursorProps) {
  throw new Error("notImplemented: HandCursor");
}
