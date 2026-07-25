import Viewport from "./scene/Viewport";
import FusionLayer from "./scene/FusionLayer";
import SpawnHandler, { SPAWN_EVENT } from "./scene/SpawnHandler";
import TransformGizmo from "./scene/TransformGizmo";
import VertexEditHandles from "./scene/VertexEditHandles";
import { VideoStreamProvider } from "./providers/VideoStream";
import { VisionSocketProvider } from "./providers/VisionSocket";
import { EmgSocketProvider } from "./providers/EmgSocket";
import ForceHUD from "./ui/ForceHUD";
import Toolbar from "./ui/Toolbar";
import CalibrationPanel from "./ui/CalibrationPanel";
import FragileWatcher from "./fragile/FragileWatcher";
import FragileSpawnButtons from "./fragile/FragileSpawnButtons";
import ConnectionStatus from "./ui/ConnectionStatus";
import CameraPip from "./ui/CameraPip";
import HandOverlay from "./ui/HandOverlay";

/**
 * App root: nests the camera/vision/EMG providers, mounts the single r3f `Viewport` (which
 * owns all scene rendering via `PhysicsWorld`), and lays the DOM overlays (HUD, calibration,
 * connection status, spawn button) alongside it.
 * @remarks `VisionSocketProvider` captures frames via `VideoStreamProvider`'s `captureFrame`,
 * so it must nest inside it. `EmgSocketProvider` wraps everything so both the Canvas
 * (`FusionLayer`) and the DOM overlays can read EMG state. Every provider degrades gracefully
 * (no camera, backends unreachable) rather than throwing, so the app always renders.
 */
function App() {
  return (
    <VideoStreamProvider>
      <VisionSocketProvider>
        <EmgSocketProvider>
          <Viewport>
            <FusionLayer />
            <SpawnHandler />
            <TransformGizmo />
            <VertexEditHandles />
          </Viewport>
          <HandOverlay />
          <CameraPip />
          <ForceHUD />
          {/* Top-right controls stacked in one column so the FRAGILE block always flows BELOW
              the toolbar (whatever its wrapped height) instead of overlapping it. */}
          <div
            style={{
              position: "fixed",
              top: 16,
              right: 16,
              zIndex: 20,
              display: "flex",
              flexDirection: "column",
              gap: 12,
              alignItems: "flex-end",
            }}
          >
            <Toolbar />
            <FragileSpawnButtons />
          </div>
          <CalibrationPanel />
          <FragileWatcher />
          <ConnectionStatus />
          <button
            onClick={() => window.dispatchEvent(new Event(SPAWN_EVENT))}
            style={{
              position: "fixed",
              bottom: 16,
              right: 16,
              zIndex: 20,
              padding: "10px 16px",
              borderRadius: 12,
              border: "1px solid rgba(255,255,255,0.2)",
              background: "rgba(15, 15, 20, 0.72)",
              color: "#fff",
              fontFamily: "system-ui, sans-serif",
              fontSize: 13,
              cursor: "pointer",
              backdropFilter: "blur(6px)",
            }}
          >
            Spawn clay (S)
          </button>
        </EmgSocketProvider>
      </VisionSocketProvider>
    </VideoStreamProvider>
  );
}

export default App;
