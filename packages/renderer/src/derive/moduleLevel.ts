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
};

/** A unit's identity strip: one class/interface/object. With members it renders as a FRAME whose
 * method nodes nest inside (isFrame); memberless it is a compact leaf card. No metric rows, no
 * uses list — dependencies are the wires' story, not the card's. */
export type UnitCardData = {
  label: string;
  unitKind: string;
  memberCount: number;
  isFrame: boolean;
};

/** The card data for one unit node — identity only. */
export function unitData(id: string, index: GraphIndex, memberCount: number): UnitCardData {
  return {
    label: unitLabel(id, index),
    unitKind: index.nodesById.get(id)?.kind ?? "class",
    memberCount,
    isFrame: memberCount > 0,
  };
}

/** A code block: a method inside a unit frame, or a file-level function/type definition.
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

export function fileData(id: string, graph: ModuleGraph, index: GraphIndex, entryId: string | null, expansion: FileExpansion): ModuleCardData {
  const modulePath = parseNodeId(id).modulePath;
  const isEntry = id === entryId;
  return {
    label: index.nodesById.get(id)?.displayName ?? basename(modulePath),
    fullPath: modulePath,
    category: isEntry ? "entry" : categorize(modulePath),
    inCount: graph.in.get(id)?.size ?? 0,
    outCount: graph.out.get(id)?.size ?? 0,
    isEntry,
    ...expansion,
  };
}

export function basename(modulePath: string): string {
  const segments = modulePath.split("/");
  return segments[segments.length - 1] ?? modulePath;
}
