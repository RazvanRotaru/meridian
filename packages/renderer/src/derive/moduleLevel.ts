/**
 * Shared helpers for the Module-map's containment tree (`moduleTree.ts`): the per-file card data,
 * the single-directory chain-collapse that skips wasted one-box levels, and a path basename. Pure —
 * no React, no ELK. Category hiding is never applied here; it's a paint concern.
 */

import { parseNodeId } from "@meridian/core";
import type { GraphIndex } from "../graph/graphIndex";
import type { ModuleGraph } from "./moduleGraph";
import { categorize, type ModuleCategory } from "./moduleCategory";
import { unitLabel } from "./blockDeps";

const MODULE_KIND = "module";
const PACKAGE_KIND = "package";
const CALLABLE_KINDS: ReadonlySet<string> = new Set(["function", "method"]);

// `type` (not interface) so it carries @xyflow/react's implicit index signature on Node<T>.
export type ModuleCardData = {
  label: string;
  fullPath: string;
  category: ModuleCategory;
  inCount: number;
  outCount: number;
  isEntry: boolean;
  /** The file holds unit (class/interface/object) children, so its card carries an expand chevron. */
  isContainer: boolean;
  /** Expanded in place: the card becomes a frame with its unit cards nested inside. */
  isExpanded: boolean;
  unitCount: number;
  /** A demoted COMMONS hub (commonsDemotion): parked in the dock, wires hidden until lit. */
  isCommons?: boolean;
  /** The commons this card depends on — worn as small chips instead of wires. */
  commonsChips?: string[];
};

/** A unit's identity strip: one class/interface/object. With members it can expand into a FRAME
 * whose method nodes nest inside; memberless it is a compact leaf card. No uses list —
 * dependencies are the wires' story, not the card's. */
export type UnitCardData = {
  label: string;
  unitKind: string;
  memberCount: number;
  isContainer: boolean;
  isExpanded: boolean;
  /** Current visual mode: true only when the unit is expanded into a frame. */
  isFrame: boolean;
};

export interface UnitExpansion {
  memberCount: number;
  isContainer: boolean;
  isExpanded: boolean;
}

/** The card data for one unit node — identity plus its inline-expansion affordance. */
export function unitData(id: string, index: GraphIndex, expansion: UnitExpansion): UnitCardData {
  return {
    label: unitLabel(id, index),
    unitKind: index.nodesById.get(id)?.kind ?? "class",
    ...expansion,
    isFrame: expansion.isExpanded,
  };
}

/** A code block: a method inside an expanded unit frame, or a file-level function/type definition.
 * The block IS the dependency anchor — its wires say what this specific code uses. A block with a
 * logic flow carries a chevron: expanding charts its flow steps in place (isExpanded → frame). */
export type BlockData = {
  label: string;
  blockKind: string;
  /** Callable blocks double-click into their logic flow (the map→logic link). */
  callable: boolean;
  /** The block has a charted logic flow, so it can expand into a flow frame in place. */
  hasFlow: boolean;
  isExpanded: boolean;
};

export interface BlockExpansion {
  hasFlow: boolean;
  isExpanded: boolean;
}

export function blockData(id: string, index: GraphIndex, expansion: BlockExpansion): BlockData {
  const kind = index.nodesById.get(id)?.kind ?? "function";
  return { label: unitLabel(id, index), blockKind: kind, callable: CALLABLE_KINDS.has(kind), ...expansion };
}

/** Descend through single-directory levels so a lone `src` box is never a wasted click. */
export function collapseChain(index: GraphIndex, focus: string): string {
  const seen = new Set<string>();
  let current = focus;
  while (!seen.has(current)) {
    seen.add(current);
    const kids = index.childrenOf(current);
    const dirs = kids.filter((node) => node.kind === PACKAGE_KIND);
    const files = kids.filter((node) => node.kind === MODULE_KIND);
    if (dirs.length === 1 && files.length === 0) {
      current = dirs[0].id;
      continue;
    }
    return current;
  }
  return current;
}

/** How the file card opens: whether it holds unit cards, and whether it is expanded in place. */
export interface FileExpansion {
  isContainer: boolean;
  isExpanded: boolean;
  unitCount: number;
}

const NO_HIDDEN: ReadonlySet<string> = new Set<string>();

export function fileData(
  id: string,
  graph: ModuleGraph,
  index: GraphIndex,
  entryId: string | null,
  expansion: FileExpansion,
  hiddenIds: ReadonlySet<string> = NO_HIDDEN,
): ModuleCardData {
  const modulePath = parseNodeId(id).modulePath;
  const isEntry = id === entryId;
  return {
    label: index.nodesById.get(id)?.displayName ?? basename(modulePath),
    fullPath: modulePath,
    category: isEntry ? "entry" : categorize(modulePath),
    // The badges count what the level actually shows: partners hidden by the Tests toggle (which
    // EXCLUDES their nodes and wires from the layout) don't count — "in 44" with the 30 test wires
    // hidden would be a claim the canvas visibly contradicts.
    inCount: countVisible(graph.in.get(id), hiddenIds),
    outCount: countVisible(graph.out.get(id), hiddenIds),
    isEntry,
    ...expansion,
  };
}

function countVisible(partners: ReadonlySet<string> | undefined, hiddenIds: ReadonlySet<string>): number {
  if (!partners) {
    return 0;
  }
  if (hiddenIds.size === 0) {
    return partners.size;
  }
  let count = 0;
  for (const partner of partners) {
    if (!hiddenIds.has(partner)) {
      count += 1;
    }
  }
  return count;
}

export function basename(modulePath: string): string {
  const segments = modulePath.split("/");
  return segments[segments.length - 1] ?? modulePath;
}
