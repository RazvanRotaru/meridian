/**
 * The diff lines inside one node's span, joined from `extensions.changedSince.files` (persisted
 * by `generate --changed-since`). An artifact without the extension — or a node without a
 * location — yields the shared empty set, so code panels can pass the result straight through.
 */

import { useMemo } from "react";
import {
  changedLineKindsFromExtensions,
  changedLineKindsWithin,
  changedLinesWithin,
  changedRangesFromExtensions,
} from "@meridian/core";
import type { ChangedLineKind, GraphNode } from "@meridian/core";
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

export function useLineChangeKinds(node: GraphNode | undefined): ReadonlyMap<number, ChangedLineKind> {
  const extensions = useBlueprint((state) => state.artifact.extensions);
  return useMemo(() => {
    const kinds = changedLineKindsFromExtensions(extensions);
    if (!kinds || !node?.location) {
      return EMPTY_KINDS;
    }
    return changedLineKindsWithin(kinds, node.location.file, node.location.startLine, node.location.endLine);
  }, [extensions, node]);
}

export interface NodeChangeSummary {
  /** Added OR modified lines within THIS node's span — the highlighted content rows the panel shows. */
  added: number;
  /** Deleted lines within the node's span. */
  deleted: number;
  /** Total changed lines within the span (added-or-modified + deleted). */
  touched: number;
}

/**
 * Node-SCOPED change summary: added-or-modified vs deleted lines WITHIN this node's own span, so the
 * chip's numbers match the coloured rows the panel actually renders — not the whole file's churn (the
 * old file-level delta claimed "+51" on a function that changed nothing). Null when the span is clean.
 */
export function useChangeSummary(node: GraphNode | undefined): NodeChangeSummary | null {
  const extensions = useBlueprint((state) => state.artifact.extensions);
  return useMemo(() => {
    if (!node?.location) {
      return null;
    }
    const { file, startLine, endLine } = node.location;
    const kinds = changedLineKindsFromExtensions(extensions);
    if (kinds) {
      let added = 0;
      let deleted = 0;
      for (const kind of changedLineKindsWithin(kinds, file, startLine, endLine).values()) {
        if (kind === "deleted") {
          deleted += 1;
        } else {
          added += 1; // added OR modified — both render as highlighted content rows
        }
      }
      return added === 0 && deleted === 0 ? null : { added, deleted, touched: added + deleted };
    }
    // Older artifact: ranges but no per-line kinds — fall back to a plain touched count.
    const ranges = changedRangesFromExtensions(extensions);
    const touched = ranges ? changedLinesWithin(ranges, file, startLine, endLine).size : 0;
    return touched === 0 ? null : { added: touched, deleted: 0, touched };
  }, [extensions, node]);
}

const EMPTY: ReadonlySet<number> = new Set();
const EMPTY_KINDS: ReadonlyMap<number, ChangedLineKind> = new Map();
