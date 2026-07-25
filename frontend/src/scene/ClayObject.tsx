/**
 * Renders a single `SceneObject` — primitive geometry or `customGeometry` for sculpted clay
 * (Task C).
 */
import { useMemo, type Ref } from "react";
import type { ThreeEvent } from "@react-three/fiber";
import * as THREE from "three";
import { useEditor } from "../store/editor";
import { useFusionStatus } from "../control/fusionStatus";
import type { InteractionMode, SceneObject } from "../types";

/** Modes where a hand pinch can pick the object up — hover shows the gold "pinch to grab" cue. */
const GRAB_CAPABLE_MODES: InteractionMode[] = ["select", "physics", "move", "rotate", "scale"];

export interface ClayObjectProps {
  object: SceneObject;
}

/** Builds a three.js `BufferGeometry` for `object`, using `customGeometry` buffers when `geometry === "custom"`. */
export function buildGeometry(object: SceneObject): THREE.BufferGeometry {
  const p = object.geometryParams ?? {};
  switch (object.geometry) {
    case "box":
      return new THREE.BoxGeometry(p.width ?? 1, p.height ?? 1, p.depth ?? 1);
    case "sphere": {
      const g = new THREE.SphereGeometry(p.radius ?? 0.5, 32, 32);
      g.computeVertexNormals();
      return g;
    }
    case "cylinder":
      return new THREE.CylinderGeometry(p.radiusTop ?? 0.5, p.radiusBottom ?? 0.5, p.height ?? 1, 32);
    case "cone":
      return new THREE.ConeGeometry(p.radius ?? 0.5, p.height ?? 1, 32);
    case "torus": {
      const g = new THREE.TorusGeometry(p.radius ?? 0.5, p.tube ?? 0.2, 16, 32);
      g.computeVertexNormals();
      return g;
    }
    case "plane":
      return new THREE.PlaneGeometry(p.width ?? 1, p.height ?? 1);
    case "custom": {
      const g = new THREE.BufferGeometry();
      const custom = object.customGeometry;
      if (custom) {
        g.setAttribute("position", new THREE.Float32BufferAttribute(custom.positions, 3));
        if (custom.indices.length) g.setIndex(custom.indices);
        if (custom.normals.length) g.setAttribute("normal", new THREE.Float32BufferAttribute(custom.normals, 3));
        else g.computeVertexNormals();
      }
      return g;
    }
    default:
      return new THREE.BoxGeometry(1, 1, 1);
  }
}

export interface ClayMeshProps {
  object: SceneObject;
  /** Forwarded to the underlying `<mesh>` so callers (e.g. `PhysicsWorld`) can register it. */
  meshRef?: Ref<THREE.Mesh>;
  /** When true, overrides the material with a red emissive tint (delete-mode hover). */
  deleteHighlight?: boolean;
  /** Forwarded to the underlying `<mesh>` for click-to-select/delete. */
  onClick?: (e: ThreeEvent<MouseEvent>) => void;
}

/**
 * Shared mesh (geometry + material + `userData.objectId` tag) for one `SceneObject`, with no
 * transform of its own — callers place it via a wrapping `<group>`/`<RigidBody>`.
 * @remarks Reused by both `ClayObject` (standalone) and `PhysicsWorld`'s `SceneBody` so
 * sculpted custom geometry and the emissive heat-glow render identically in both paths, and
 * `useFusion`'s raycast can resolve `mesh.userData.objectId` regardless of which owns it.
 * Selection/hover/grab/delete states are surfaced by driving the mesh's own `emissive` (not a
 * drei `<Edges>` outline, which does not render in this project); priority is delete(red) >
 * grabbed(cyan) > hover(gold) > selected(blue) > the object's own emissive. A thin darker-tint
 * `WireframeGeometry` overlay (rendered as a non-raycasting `<lineSegments>` sibling) gives every
 * shape a subtle "lines/grid" edge on top of its pastel fill.
 */
export function ClayMesh({ object, meshRef, deleteHighlight, onClick }: ClayMeshProps) {
  // Custom geometry is rebuilt whenever its buffers change (sculpt edits); primitives rebuild on param change.
  const geometry = useMemo(() => buildGeometry(object), [
    object.geometry,
    object.geometryParams,
    object.customGeometry,
  ]);
  const isSelected = useEditor((s) => s.selectedId === object.id);
  const interactionMode = useEditor((s) => s.interactionMode);
  const hoveredObjectId = useFusionStatus((s) => s.hoveredObjectId);
  const heldObjectId = useFusionStatus((s) => s.heldObjectId);
  const isGrabbed = heldObjectId === object.id;
  const isGoldHover =
    !deleteHighlight &&
    !isGrabbed &&
    hoveredObjectId === object.id &&
    GRAB_CAPABLE_MODES.includes(interactionMode);

  // ShapeShift-style: highlight by making the whole object GLOW (emissive), not a thin edge
  // outline (drei <Edges> wasn't rendering). Priority: delete(red) > grabbed(cyan) >
  // hover(gold) > selected(blue) > the object's own emissive.
  let emissiveColor = object.material.emissive;
  let emissiveIntensity = object.material.emissiveIntensity;
  // Bumped vs. the original dark-theme values: the brighter shadowless lighting + light pastel
  // background wash out lower emissive intensities, so highlights need more headroom to still
  // read clearly (esp. gold hover against light fills).
  if (deleteHighlight) {
    emissiveColor = "#ff1a1a";
    emissiveIntensity = 1.1;
  } else if (isGrabbed) {
    emissiveColor = "#22e0ff";
    emissiveIntensity = 1.15;
  } else if (isGoldHover) {
    emissiveColor = "#ffcc33";
    emissiveIntensity = 1.1;
  } else if (isSelected) {
    emissiveColor = "#4dabf7";
    emissiveIntensity = 0.75;
  }

  // Thin wireframe/edge-line overlay for the "lines/grid" playground look. Built directly from
  // the same geometry via THREE.WireframeGeometry (drei's <Edges> does not render in this
  // project) and rendered as a sibling <lineSegments>, so it moves/scales in lockstep with the
  // solid mesh with no extra transform bookkeeping.
  const wireframeGeometry = useMemo(() => new THREE.WireframeGeometry(geometry), [geometry]);
  // Wire tint: a MUCH darker shade of the fill color (was x0.55) reads as a crisp, well-defined
  // edge/"grid" line on any pastel instead of a faint tint.
  const wireColor = useMemo(
    () => new THREE.Color(object.material.color).multiplyScalar(0.3),
    [object.material.color],
  );

  return (
    <mesh ref={meshRef} geometry={geometry} scale={object.scale} userData={{ objectId: object.id }} onClick={onClick}>
      <meshStandardMaterial
        color={object.material.color}
        metalness={object.material.metalness}
        roughness={object.material.roughness}
        emissive={emissiveColor}
        emissiveIntensity={emissiveIntensity}
      />
      <lineSegments geometry={wireframeGeometry} scale={[1.001, 1.001, 1.001]} raycast={() => null}>
        <lineBasicMaterial color={wireColor} transparent opacity={0.55} />
      </lineSegments>
    </mesh>
  );
}

/** Renders one `SceneObject` standalone (position/rotation via a wrapping `<group>`, scale on the mesh itself via `ClayMesh`). */
export default function ClayObject({ object }: ClayObjectProps) {
  return (
    <group position={object.position} rotation={object.rotation}>
      <ClayMesh object={object} />
    </group>
  );
}
