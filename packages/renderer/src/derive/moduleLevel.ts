/**
 * Shared helpers for the Module-map's containment tree (`moduleTree.ts`): the per-file card data,
 * the single-directory chain-collapse that skips wasted one-box levels, and a path basename. Pure —
 * no React, no ELK. Category hiding is never applied here; it's a paint concern.
 */

import { parseNodeId } from "@meridian/core";
import type { GraphIndex } from "../graph/graphIndex";
import type { ModuleGraph } from "./moduleGraph";
import { categorize, type ModuleCategory } from "./moduleCategory";
import { unitLabel, type UnitDep, type UnitDeps } from "./unitDeps";

const MODULE_KIND = "module";
const PACKAGE_KIND = "package";
const MEMBER_KINDS: ReadonlySet<string> = new Set(["function", "method"]);

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

/** A unit card: one class/interface/object, its callable members (each a logic-flow link), and the
 * units it depends on (the "service dependencies" its wires point at). */
export type UnitCardData = {
  label: string;
  unitKind: string;
  members: Array<{ id: string; name: string }>;
  deps: UnitDep[];
};

/** The card data for one unit node: name, kind, callable members, and its dependency units. */
export function unitData(id: string, index: GraphIndex, unitDeps: UnitDeps): UnitCardData {
  const node = index.nodesById.get(id);
  return {
    label: unitLabel(id, index),
    unitKind: node?.kind ?? "class",
    members: index
      .childrenOf(id)
      .filter((child) => MEMBER_KINDS.has(child.kind))
      .map((child) => ({ id: child.id, name: unitLabel(child.id, index) })),
    deps: unitDeps.depsByUnit.get(id) ?? [],
  };
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
