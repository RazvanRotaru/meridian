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

import { useEffect, useRef, useState } from "react";
import type { NodeMouseHandler, Node } from "@xyflow/react";
import { useBlueprint, useBlueprintActions } from "../../state/StoreContext";
import { activeModuleSurfaceSpec } from "./surfaceSpec";
import type { BlockData } from "../../derive/moduleLevel";

const SELECT_CLICK_DELAY_MS = 250;
const PACKAGE_KIND = "package";

export interface NodeInteractionOverrides {
  /** Return true to fully handle the click and skip the shared select/toggle path. */
  onBeforeClick?: (event: React.MouseEvent, node: Node) => boolean;
  /** Return true to fully handle a REAL node's double-click and skip the shared navigate path.
   * Synthetic ghost groups disclose before this hook because they are never navigation targets. */
  onBeforeDoubleClick?: (event: React.MouseEvent, node: Node) => boolean;
}

/** The hook's result — what a mount threads into its GraphSurface's <ReactFlow>. */
export interface ModuleNodeHandlers {
  onNodeClick: NodeMouseHandler<Node>;
  onNodeDoubleClick: NodeMouseHandler<Node>;
  onPaneClick: () => void;
  /** Paint-only inspection for a ghost; deliberately separate from the graph's primary selection. */
  inspectedGhostId: string | null;
  /** Real parent anchors expanded for the current selection. Exact ghosts remain canonical; this
   * mount-local set only tells the shared paint pass which child neighbours to disclose. */
  expandedGhostGroupIds: ReadonlySet<string>;
}

export function useModuleNodeInteractions(overrides: NodeInteractionOverrides = {}): ModuleNodeHandlers {
  const viewMode = useBlueprint((s) => s.viewMode);
  const primarySelection = useBlueprint((s) => s.moduleSelected);
  const effectiveFocus = useBlueprint((s) => s.moduleEffectiveFocus);
  const minimalOpen = useBlueprint((s) => s.minimalSeedIds.length > 0);
  const minimalMembers = useBlueprint((s) => s.minimalMemberIds);
  const moduleLayoutStatus = useBlueprint((s) => s.moduleLayoutStatus);
  const minimalLayoutStatus = useBlueprint((s) => s.minimalLayoutStatus);
  const hiddenCategories = useBlueprint((s) => s.hiddenCategories);
  const hiddenRelKinds = useBlueprint((s) => s.hiddenRelKinds);
  const moduleRadius = useBlueprint((s) => s.moduleRadius);
  const highlightMode = useBlueprint((s) => s.highlightMode);
  const showTests = useBlueprint((s) => s.showTests);
  const showPrivate = useBlueprint((s) => s.showPrivate);
  const groupGhostsByParent = useBlueprint((s) => s.groupGhostsByParent);
  // The minimal overlay reuses the UNDERLYING lens's spec by construction (`viewMode` stays
  // "modules"/"call" while it covers the Map), so its gestures are the Map's/Service's exactly.
  const spec = activeModuleSurfaceSpec(viewMode);
  const { selectModule, toggleModuleSelect, setModuleFocus, toggleModuleExpand, revealModule, revealServiceGhost, openLogicFlow } = useBlueprintActions();
  const pendingSelectTimer = useRef<ReturnType<typeof window.setTimeout> | null>(null);
  const pendingSelectId = useRef<string | null>(null);
  // Mount-local by design: the Map and its minimal overlay must never share transient inspection.
  const [inspectedGhostId, setInspectedGhostId] = useState<string | null>(null);
  const [expandedGhostGroupIds, setExpandedGhostGroupIds] = useState<Set<string>>(() => new Set());

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
  // Store-driven navigation/selection (palette, lens carry, filters, focus changes) can bypass the
  // pointer handlers below. A transient inspection must never reappear when an old id returns.
  useEffect(() => {
    setInspectedGhostId(null);
    setExpandedGhostGroupIds(new Set());
  }, [
    primarySelection,
    effectiveFocus,
    hiddenCategories,
    hiddenRelKinds,
    highlightMode,
    minimalLayoutStatus,
    minimalMembers,
    minimalOpen,
    moduleLayoutStatus,
    moduleRadius,
    groupGhostsByParent,
    showPrivate,
    showTests,
    viewMode,
  ]);
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setInspectedGhostId(null);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  const onNodeClick: NodeMouseHandler<Node> = (event, node) => {
    const ghostGroup = ghostGroupInteractionOf(node);
    if (ghostGroup !== null) {
      clearPendingSelect();
      setInspectedGhostId(null);
      // A native double-click delivers click(detail=1), click(detail=2), then dblclick. The first
      // click discloses the parent; ignoring the second prevents an open→closed flicker before the
      // double-click handler consumes the group as a non-navigation target.
      if (shouldToggleGhostGroupClick(event.detail)) {
        setExpandedGhostGroupIds((current) => toggleExpandedGhostGroupIds(current, ghostGroup.id));
      }
      return;
    }
    if (overrides.onBeforeClick?.(event, node)) {
      return;
    }
    // Ghosts are detached context, not a new graph focus. Inspecting one must leave the selected
    // core node (and therefore every ghost's selection-relative position) exactly as it was.
    if (node.type === "ghost") {
      clearPendingSelect();
      setInspectedGhostId(node.id);
      return;
    }
    setInspectedGhostId(null);
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
  // Double-click follows the surface's spec: a card whose kind the surface declares DIVABLE zooms
  // (the Map dives packages AND files; the Service lens dives only its `svc:` cluster frames); any
  // other package-kind container expands in place (the chevron's gesture). A GHOST reveals through
  // the spec (the Map refocuses at the definition; the Service lens opens the owning frame); a
  // callable BLOCK opens its logic flow (the map→logic link); everything else only selects. The
  // breadcrumb is the way back up.
  const onNodeDoubleClick: NodeMouseHandler<Node> = (event, node) => {
    // React Flow delivers the constituent clicks before a double-click. Cancel either a queued
    // core selection or a transient ghost inspection before running the existing reveal path.
    clearPendingSelect();
    setInspectedGhostId(null);
    // A persistent parent group is a disclosure control, not a graph-navigation target. Its first
    // constituent click already toggled it; consume dblclick without changing state again. Handle it
    // before the minimal overlay's close-before-navigation override.
    if (ghostGroupInteractionOf(node) !== null) {
      return;
    }
    if (overrides.onBeforeDoubleClick?.(event, node)) {
      return;
    }
    const surfaceActions = { setModuleFocus, revealModule, revealServiceGhost };
    const { dive, divable } = spec.focus;
    if (dive !== null && divable(node.type, node.id)) {
      dive(surfaceActions, node.id);
    } else if (node.type === PACKAGE_KIND) {
      toggleModuleExpand(node.id);
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
    setInspectedGhostId(null);
    selectModule(null);
  };

  return { onNodeClick, onNodeDoubleClick, onPaneClick, inspectedGhostId, expandedGhostGroupIds };
}

export interface GhostGroupInteraction {
  id: string;
  expanded: boolean;
}

export function ghostGroupInteractionOf(node: Node): GhostGroupInteraction | null {
  if (node.type !== "ghost") return null;
  const data = node.data as { ghostGroupId?: unknown; ghostExpanded?: unknown };
  return typeof data.ghostGroupId === "string" && data.ghostGroupId.length > 0
    ? { id: data.ghostGroupId, expanded: data.ghostExpanded === true }
    : null;
}

/** One click toggles a parent group; a repeated click collapses it without touching selection. */
export function toggleExpandedGhostGroupIds(current: ReadonlySet<string>, groupId: string): Set<string> {
  const next = new Set(current);
  if (next.has(groupId)) next.delete(groupId);
  else next.add(groupId);
  return next;
}

/** See the click-sequence note in `onNodeClick`; keyboard-generated clicks report detail 0. */
export function shouldToggleGhostGroupClick(detail: number): boolean {
  return detail < 2;
}
