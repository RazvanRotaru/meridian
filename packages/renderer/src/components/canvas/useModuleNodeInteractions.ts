/**
 * The Module-map's own node/canvas interaction set, extracted so any surface that reuses the Map's
 * cards behaves IDENTICALLY by construction. It owns the click-debounce + the three pointer
 * handlers, reading the active SurfaceSpec (via `viewMode`) and the module actions live from the
 * store (never threaded in). Callers can inject page-specific bits via
 * `onBeforeClick`/`onBeforeDoubleClick` — return true to fully handle the event and skip the shared
 * select/navigate path; return false (or nothing) to fall through to the Map's.
 *
 * Emphasis repaints replace the node array; deferring plain selection keeps nested parent-relative
 * hit targets stable long enough for React Flow to assemble the native double-click on the node.
 *
 * Called by each MOUNT (not by the shared GraphSurface), because the debounce timer's lifetime must
 * match the LENS, not the canvas instance: the Map's pending single-click select survives the
 * minimal overlay replacing its canvas — it still lands under the overlay, exactly as it always did
 * — while the overlay's own pending select dies with the overlay on close.
 */

import { useEffect, useRef } from "react";
import type { NodeMouseHandler, Node } from "@xyflow/react";
import { useBlueprint, useBlueprintActions } from "../../state/StoreContext";
import { activeModuleSurfaceSpec } from "./surfaceSpec";
import type { BlockData } from "../../derive/moduleLevel";

const SELECT_CLICK_DELAY_MS = 250;
const PACKAGE_KIND = "package";
const FILE_KIND = "file";

export interface NodeInteractionOverrides {
  /** Return true to fully handle the click and skip the shared select/toggle path. */
  onBeforeClick?: (event: React.MouseEvent, node: Node) => boolean;
  /** Return true to fully handle the double-click and skip the shared navigate path. */
  onBeforeDoubleClick?: (event: React.MouseEvent, node: Node) => boolean;
}

/** The hook's result — what a mount threads into its GraphSurface's <ReactFlow>. */
export interface ModuleNodeHandlers {
  onNodeClick: NodeMouseHandler<Node>;
  onNodeDoubleClick: NodeMouseHandler<Node>;
  onPaneClick: () => void;
}

export function useModuleNodeInteractions(overrides: NodeInteractionOverrides = {}): ModuleNodeHandlers {
  const viewMode = useBlueprint((s) => s.viewMode);
  // The minimal overlay reuses the UNDERLYING lens's spec by construction (`viewMode` stays
  // "modules"/"call" while it covers the Map), so its gestures are the Map's/Service's exactly.
  const spec = activeModuleSurfaceSpec(viewMode);
  const { selectModule, toggleModuleSelect, setModuleFocus, toggleModuleExpand, revealModule, openLogicFlow } = useBlueprintActions();
  const pendingSelectTimer = useRef<ReturnType<typeof window.setTimeout> | null>(null);
  const pendingSelectId = useRef<string | null>(null);

  const clearPendingSelect = () => {
    if (pendingSelectTimer.current !== null) {
      window.clearTimeout(pendingSelectTimer.current);
    }
    pendingSelectTimer.current = null;
    pendingSelectId.current = null;
  };
  const flushPendingSelect = () => {
    const pendingId = pendingSelectId.current;
    if (pendingId === null) {
      return;
    }
    clearPendingSelect();
    selectModule(pendingId);
  };
  // Clear any pending single-click select on unmount so a queued timeout can't fire after teardown.
  useEffect(
    () => () => {
      if (pendingSelectTimer.current !== null) {
        window.clearTimeout(pendingSelectTimer.current);
      }
      pendingSelectTimer.current = null;
      pendingSelectId.current = null;
    },
    [],
  );

  const onNodeClick: NodeMouseHandler<Node> = (event, node) => {
    if (overrides.onBeforeClick?.(event, node)) {
      return;
    }
    if (event.ctrlKey || event.metaKey) {
      flushPendingSelect();
      toggleModuleSelect(node.id);
      return;
    }
    clearPendingSelect();
    pendingSelectId.current = node.id;
    pendingSelectTimer.current = window.setTimeout(() => {
      selectModule(node.id);
      pendingSelectTimer.current = null;
      pendingSelectId.current = null;
    }, SELECT_CLICK_DELAY_MS);
  };
  // Double-click follows the surface's spec: on a focus-model surface (the Map) a package/file card
  // DIVES into it (setModuleFocus); on a focus-less surface (Service) a package frame expands in
  // place instead. A GHOST reveals through the spec (the Map refocuses where its definition lives);
  // a callable BLOCK opens its logic flow (the map→logic link); everything else only selects. The
  // breadcrumb is the way back up.
  const onNodeDoubleClick: NodeMouseHandler<Node> = (event, node) => {
    if (overrides.onBeforeDoubleClick?.(event, node)) {
      return;
    }
    clearPendingSelect();
    const surfaceActions = { setModuleFocus, revealModule };
    const dive = spec.dive;
    if (node.type === PACKAGE_KIND && dive === null) {
      toggleModuleExpand(node.id);
    } else if (dive !== null && (node.type === PACKAGE_KIND || node.type === FILE_KIND)) {
      dive(surfaceActions, node.id);
    } else if (node.type === "ghost") {
      spec.ghostReveal(surfaceActions, node.id);
    } else if (node.type === "block" && (node.data as BlockData).callable) {
      openLogicFlow(node.id);
    } else {
      selectModule(node.id);
    }
  };
  const onPaneClick = () => {
    clearPendingSelect();
    selectModule(null);
  };

  return { onNodeClick, onNodeDoubleClick, onPaneClick };
}
