/**
 * The diff lines inside one node's span, joined from `extensions.changedSince.files` (persisted
 * by `generate --changed-since`). An artifact without the extension — or a node without a
 * location — yields the shared empty set, so code panels can pass the result straight through.
 */

import { useMemo } from "react";
import {
  changedLineDeltaForNode,
  changedLineStatsFromExtensions,
  changedLinesWithin,
  changedRangesFromExtensions,
} from "@meridian/core";
import type { GraphNode } from "@meridian/core";
import { useBlueprint } from "../state/StoreContext";

// Accepts undefined so a panel can satisfy the rules of hooks and call this before its
// nothing-to-show early return (the modal renders hooks-first, then bails).
export function useChangedLines(node: GraphNode | undefined): ReadonlySet<number> {
  const extensions = useBlueprint((state) => state.artifact.extensions);
  return useMemo(() => {
    const ranges = changedRangesFromExtensions(extensions);
    if (!ranges || !node?.location) {
      return EMPTY;
    }
    return changedLinesWithin(ranges, node.location.file, node.location.startLine, node.location.endLine);
  }, [extensions, node]);
}

export interface NodeChangeSummary {
  added: number;
  deleted: number;
  touched: number;
}

/** Added/deleted summary for a node's file (plus touched lines in the node span), or null untouched. */
export function useChangeSummary(node: GraphNode | undefined): NodeChangeSummary | null {
  const extensions = useBlueprint((state) => state.artifact.extensions);
  return useMemo(() => {
    if (!node?.location) {
      return null;
    }
    const ranges = changedRangesFromExtensions(extensions);
    const touched = ranges
      ? changedLinesWithin(ranges, node.location.file, node.location.startLine, node.location.endLine).size
      : 0;
    const stats = changedLineStatsFromExtensions(extensions);
    const delta = stats ? changedLineDeltaForNode(stats, node) : null;
    if (!delta && touched === 0) {
      return null;
    }
    return {
      added: delta?.added ?? touched,
      deleted: delta?.deleted ?? 0,
      touched,
    };
  }, [extensions, node]);
}

const EMPTY: ReadonlySet<number> = new Set();
