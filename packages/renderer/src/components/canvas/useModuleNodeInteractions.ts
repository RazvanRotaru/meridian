/**
 * The Module-map's own node/canvas interaction set, extracted so any surface that reuses the Map's
 * cards behaves IDENTICALLY by construction. It owns the click-debounce + the three pointer handlers,
 * reading `viewMode` and the module actions live from the store (never threaded in). Callers can inject
 * page-specific bits via `onBeforeClick`/`onBeforeDoubleClick` — return true to fully handle the event
 * and skip the shared select/navigate path; return false (or nothing) to fall through to the Map's.
 *
 * Emphasis repaints replace the node array; deferring plain selection keeps nested parent-relative hit
 * targets stable long enough for React Flow to assemble the native double-click on the node.
 */

import { useEffect, useRef } from "react";
import type { NodeMouseHandler, Node } from "@xyflow/react";
import { useBlueprint, useBlueprintActions } from "../../state/StoreContext";
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

export function useModuleNodeInteractions(overrides: NodeInteractionOverrides = {}) {
  const viewMode = useBlueprint((s) => s.viewMode);
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
  // Double-click a package/file card zooms into it; a callable BLOCK opens its logic flow (the
  // map→logic link); a GHOST reveals its off-screen definition (the Map refocuses where it lives);
  // everything else only selects. The breadcrumb is the way back up.
  const onNodeDoubleClick: NodeMouseHandler<Node> = (event, node) => {
    // A double-click ALWAYS cancels the pending single-click select first (before any override), so a
    // queued select can't fire 250ms later and clobber a selection the override just set (e.g. reveal).
    clearPendingSelect();
    if (overrides.onBeforeDoubleClick?.(event, node)) {
      return;
    }
    if (node.type === PACKAGE_KIND && viewMode === "call") {
      toggleModuleExpand(node.id);
    } else if (viewMode !== "call" && (node.type === PACKAGE_KIND || node.type === FILE_KIND)) {
      setModuleFocus(node.id);
    } else if (node.type === "ghost") {
      revealModule(node.id);
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
