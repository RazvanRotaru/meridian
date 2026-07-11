/**
 * The Module-map's own node/canvas interaction set, extracted so any surface that reuses the Map's
 * cards behaves IDENTICALLY by construction. It owns the click-debounce + the three pointer
 * handlers, reading the active SurfaceSpec (via `viewMode`) and the module actions live from the
 * store (never threaded in). Callers can inject a page-specific side effect immediately before
 * navigation (the minimal overlay closes itself there), but cannot consume the universal gesture.
 *
 * Emphasis repaints replace the node array; deferring plain selection keeps nested parent-relative
 * hit targets stable long enough for React Flow to assemble the native double-click on the node.
 *
 * Called by each MOUNT (not by the shared GraphSurface), because the debounce timer's lifetime must
 * match the LENS, not the canvas instance: the source Map's pending single-click select survives
 * while the minimal overlay covers it, while the overlay's own pending select dies on close.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import type { NodeMouseHandler, Node } from "@xyflow/react";
import { useBlueprint, useBlueprintActions } from "../../state/StoreContext";
import { activeModuleSurfaceSpec, type SurfaceSpec } from "./surfaceSpec";
import type { BlockData } from "../../derive/moduleLevel";

const SELECT_CLICK_DELAY_MS = 250;

export interface NodeInteractionOverrides {
  /** A pre-navigation side effect; navigation always continues afterward. */
  onBeforeDoubleClick?: (event: React.MouseEvent, node: Node) => void;
}

/** The hook's result — what a mount threads into its GraphSurface's <ReactFlow>. */
export interface ModuleNodeHandlers {
  onNodeClick: NodeMouseHandler<Node>;
  onNodeDoubleClick: NodeMouseHandler<Node>;
  onPaneClick: () => void;
  /** Real parent anchors expanded for the current selection. Exact ghosts remain canonical; this
   * mount-local set only tells the shared paint pass which child neighbours to disclose. */
  expandedGhostGroupIds: ReadonlySet<string>;
  /** Explicit disclosure action rendered by a grouped ghost parent's own chevron. */
  toggleGhostGroup(groupId: string): void;
  /** Complete paint-owner override for the current literal selection. Ghost entries contribute
   * their captured provenance; ordinary entries remain their own paint seeds. */
  paintSelectionOverride: ReadonlySet<string> | null;
}

export interface GhostPaintContext {
  targetId: string;
  seedIds: ReadonlySet<string>;
  viewMode: string;
  effectiveFocus: string | null;
}

/** Provenance is valid through its own debounce and for as long as that ghost remains selected. */
export function retainsGhostPaintContext(
  targetId: string,
  selected: ReadonlySet<string>,
  pendingSelectId: string | null,
): boolean {
  return pendingSelectId === targetId || selected.has(targetId);
}

/** Build the complete traversal seed set for a selection containing captured ghosts. A pending
 * ghost click already carries the provenance that will replace the old selection; a pending real
 * click keeps the current provenance until its 250 ms debounce commits. For a committed
 * Ctrl-selection, each ghost contributes its OWN provenance while real nodes seed themselves; no
 * global LCA can merge unrelated ghost owners. */
export function ghostPaintSeedOverride(
  contexts: ReadonlyMap<string, GhostPaintContext>,
  selected: ReadonlySet<string>,
  pendingSelectId: string | null,
): ReadonlySet<string> | null {
  if (pendingSelectId !== null) {
    const pending = contexts.get(pendingSelectId);
    if (pending !== undefined) {
      return new Set(pending.seedIds);
    }
    // A real-node replacement is deliberately delayed so a double-click can win. Until that
    // selection actually commits, retain the current ghost provenance: an unrelated repaint
    // (for example a review hover) must not move the clicked target during the arbitration window.
  }
  const seeds = new Set<string>();
  let hasGhostContext = false;
  for (const id of selected) {
    const context = contexts.get(id);
    if (context === undefined) {
      seeds.add(id);
      continue;
    }
    hasGhostContext = true;
    context.seedIds.forEach((seedId) => seeds.add(seedId));
  }
  return hasGhostContext ? seeds : null;
}

export function useModuleNodeInteractions(overrides: NodeInteractionOverrides = {}): ModuleNodeHandlers {
  const viewMode = useBlueprint((s) => s.viewMode);
  const effectiveFocus = useBlueprint((s) => s.moduleEffectiveFocus);
  const minimalOpen = useBlueprint((s) => s.minimalSeedIds.length > 0);
  const minimalMembers = useBlueprint((s) => s.minimalMemberIds);
  const moduleLayoutStatus = useBlueprint((s) => s.moduleLayoutStatus);
  const minimalLayoutStatus = useBlueprint((s) => s.minimalLayoutStatus);
  const hiddenCategories = useBlueprint((s) => s.hiddenCategories);
  const relationVisibilityOverrides = useBlueprint((s) => s.relationVisibilityOverrides);
  const moduleRadius = useBlueprint((s) => s.moduleRadius);
  const highlightMode = useBlueprint((s) => s.highlightMode);
  const showTests = useBlueprint((s) => s.showTests);
  const showPrivate = useBlueprint((s) => s.showPrivate);
  const groupGhostsByParent = useBlueprint((s) => s.groupGhostsByParent);
  const moduleSelected = useBlueprint((s) => s.moduleSelected);
  // The minimal overlay reuses the UNDERLYING lens's spec by construction (`viewMode` stays
  // "modules"/"call" while it covers the Map), so its gestures are the Map's/Service's exactly.
  const spec = activeModuleSurfaceSpec(viewMode);
  const {
    selectModule,
    toggleModuleSelect,
    setModuleFocus,
    revealModule,
    revealServiceGhost,
    revealInView,
    openLogicFlow,
  } = useBlueprintActions();
  const pendingSelectTimer = useRef<ReturnType<typeof window.setTimeout> | null>(null);
  const pendingSelectId = useRef<string | null>(null);
  const [expandedGhostGroupIds, setExpandedGhostGroupIds] = useState<Set<string>>(() => new Set());
  const [ghostPaintContexts, setGhostPaintContexts] = useState<Map<string, GhostPaintContext>>(() => new Map());
  const toggleGhostGroup = useCallback((groupId: string) => {
    setExpandedGhostGroupIds((current) => toggleExpandedGhostGroupIds(current, groupId));
  }, []);

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
  // A disclosed ghost neighbourhood belongs to the current graph projection. Reset it when that
  // projection changes, but NOT when selection changes: selecting one of the disclosed children
  // must not immediately fold the child away again.
  useEffect(() => {
    setExpandedGhostGroupIds(new Set());
    setGhostPaintContexts(new Map());
  }, [
    effectiveFocus,
    hiddenCategories,
    relationVisibilityOverrides,
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

  const rememberGhostPaintContext = (node: Node, gesture: SelectionGesture) => {
    if (node.type !== "ghost") {
      return;
    }
    const provenance = (node.data as { ghostPaintSeedIds?: unknown }).ghostPaintSeedIds;
    const ids = Array.isArray(provenance)
      ? provenance.filter((id): id is string => typeof id === "string" && id.length > 0)
      : [];
    setGhostPaintContexts((current) => {
      const next = gesture === "replace" ? new Map<string, GhostPaintContext>() : new Map(current);
      if (ids.length === 0) {
        next.delete(node.id);
        return next;
      }
      next.set(node.id, {
        targetId: node.id,
        seedIds: new Set(ids),
        viewMode,
        effectiveFocus,
      });
      return next;
    });
  };
  // Store actions outside this canvas (sidebar reveal, lens carry, review navigation) can replace
  // selection without firing a node handler. Retire each provenance entry as soon as its ghost is
  // no longer selected; the pending click exemption bridges only the deliberate 250 ms debounce.
  useEffect(() => {
    setGhostPaintContexts((current) => {
      let next: Map<string, GhostPaintContext> | null = null;
      for (const [targetId] of current) {
        if (retainsGhostPaintContext(targetId, moduleSelected, pendingSelectId.current)) continue;
        next ??= new Map(current);
        next.delete(targetId);
      }
      return next ?? current;
    });
  }, [moduleSelected]);

  const onNodeClick: NodeMouseHandler<Node> = (event, node) => {
    // Selection is deliberately type-agnostic: real cards, synthetic parents, exact ghosts and
    // grouped ghost parents all enter the same selection (and therefore extraction) path.
    const gesture = selectionGestureFor(node, event);
    if (gesture === "toggle") {
      flushPendingSelect();
      rememberGhostPaintContext(node, gesture);
      toggleModuleSelect(node.id);
      return;
    }
    clearPendingSelect();
    rememberGhostPaintContext(node, gesture);
    pendingSelectId.current = node.id;
    pendingSelectTimer.current = window.setTimeout(() => {
      selectModule(node.id);
      pendingSelectTimer.current = null;
      pendingSelectId.current = null;
    }, SELECT_CLICK_DELAY_MS);
  };
  // Double-click is navigation only. Expansion/collapse belongs exclusively to the node chevrons
  // and the canvas actions; no double-click branch may mutate `moduleExpanded`. Breadcrumb and
  // outward semantic navigation remain the ways back through the surface's real hierarchy.
  const onNodeDoubleClick: NodeMouseHandler<Node> = (event, node) => {
    // React Flow delivers the constituent clicks before a double-click. Cancel either a queued
    // selection before running the navigation path.
    clearPendingSelect();
    setGhostPaintContexts(new Map());
    overrides.onBeforeDoubleClick?.(event, node);
    const surfaceActions = { setModuleFocus, revealModule, revealServiceGhost };
    const navigation = navigationForNode(node, spec);
    switch (navigation.kind) {
      case "navigate-into":
        spec.navigation.navigateInto?.(surfaceActions, navigation.id);
        break;
      case "ghost-reveal":
        spec.ghostReveal(surfaceActions, navigation.id);
        break;
      case "logic":
        openLogicFlow(navigation.id);
        break;
      case "reveal":
        revealInView(navigation.id);
        break;
    }
  };
  const onPaneClick = () => {
    clearPendingSelect();
    setGhostPaintContexts(new Map());
    selectModule(null);
  };

  const scopedGhostPaintContexts = new Map(
    [...ghostPaintContexts].filter(([, context]) =>
      context.viewMode === viewMode && context.effectiveFocus === effectiveFocus),
  );
  const paintSelectionOverride = ghostPaintSeedOverride(
    scopedGhostPaintContexts,
    moduleSelected,
    pendingSelectId.current,
  );
  return {
    onNodeClick,
    onNodeDoubleClick,
    onPaneClick,
    expandedGhostGroupIds,
    toggleGhostGroup,
    paintSelectionOverride,
  };
}

export type SelectionGesture = "replace" | "toggle";

/** The universal click contract is independent of node kind: plain click replaces selection,
 * ctrl/cmd click toggles membership. Keeping the node parameter makes that invariant testable. */
export function selectionGestureFor(
  _node: Node,
  event: Pick<React.MouseEvent, "ctrlKey" | "metaKey">,
): SelectionGesture {
  return event.ctrlKey || event.metaKey ? "toggle" : "replace";
}

export type NodeNavigation =
  | { kind: "navigate-into"; id: string }
  | { kind: "ghost-reveal"; id: string }
  | { kind: "logic"; id: string }
  | { kind: "reveal"; id: string };

/** Resolve a double-click without side effects. No outcome is `select` or `expand`: every card
 * reaches one of the current lens's navigation paths. Grouped ghost parents keep their REAL parent
 * id, so they reveal exactly like an ungrouped ghost rather than acting as disclosure gestures. */
export function navigationForNode(node: Node, spec: SurfaceSpec): NodeNavigation {
  if (spec.navigation.navigateInto !== null && spec.navigation.canNavigateInto(node.type, node.id)) {
    return { kind: "navigate-into", id: node.id };
  }
  if (node.type === "ghost") {
    return { kind: "ghost-reveal", id: node.id };
  }
  if (node.type === "block" && (node.data as BlockData).callable) {
    return { kind: "logic", id: node.id };
  }
  if (node.type === "step") {
    const owner = artifactOwnerOfStep(node.id);
    if (owner !== null) {
      return { kind: "logic", id: owner };
    }
  }
  return { kind: "reveal", id: node.id };
}

/** Step ids nest as `step:<owner>:<index>`; peel those view-only wrappers until the real callable
 * owner remains, so double-clicking any in-place flow step navigates to its Logic graph. */
export function artifactOwnerOfStep(id: string): string | null {
  let owner = id;
  let peeled = false;
  while (owner.startsWith("step:")) {
    const lastColon = owner.lastIndexOf(":");
    if (lastColon <= "step:".length || !/^\d+$/.test(owner.slice(lastColon + 1))) {
      return null;
    }
    owner = owner.slice("step:".length, lastColon);
    peeled = true;
  }
  return peeled && owner.length > 0 ? owner : null;
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

/** The grouped ghost parent's explicit chevron opens/closes a stable real-parent id. */
export function toggleExpandedGhostGroupIds(current: ReadonlySet<string>, groupId: string): Set<string> {
  const next = new Set(current);
  if (next.has(groupId)) next.delete(groupId);
  else next.add(groupId);
  return next;
}
