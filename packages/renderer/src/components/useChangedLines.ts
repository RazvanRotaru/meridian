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

// `wholeFile` widens the span from the node's own lines to the entire file (start 1..EOF) so the
// diff panel that shows the whole file paints — and scrolls to — every change in it, not just the
// node's. Accepts undefined `node` so a panel can call this before its nothing-to-show early return.
export function useChangedLines(node: GraphNode | undefined, wholeFile = false): ReadonlySet<number> {
  const extensions = useBlueprint((state) => state.artifact.extensions);
  return useMemo(() => {
    const ranges = changedRangesFromExtensions(extensions);
    if (!ranges || !node?.location) {
      return EMPTY;
    }
    const { file, startLine, endLine } = node.location;
    return wholeFile
      ? changedLinesWithin(ranges, file, 1, Number.MAX_SAFE_INTEGER)
      : changedLinesWithin(ranges, file, startLine, endLine);
  }, [extensions, node, wholeFile]);
}

export function useLineChangeKinds(node: GraphNode | undefined, wholeFile = false): ReadonlyMap<number, ChangedLineKind> {
  const extensions = useBlueprint((state) => state.artifact.extensions);
  return useMemo(() => {
    const kinds = changedLineKindsFromExtensions(extensions);
    if (!kinds || !node?.location) {
      return EMPTY_KINDS;
    }
    const { file, startLine, endLine } = node.location;
    return wholeFile
      ? changedLineKindsWithin(kinds, file, 1, Number.MAX_SAFE_INTEGER)
      : changedLineKindsWithin(kinds, file, startLine, endLine);
  }, [extensions, node, wholeFile]);
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
export function useChangeSummary(node: GraphNode | undefined, wholeFile = false): NodeChangeSummary | null {
  const extensions = useBlueprint((state) => state.artifact.extensions);
  return useMemo(() => {
    if (!node?.location) {
      return null;
    }
    // Whole-file panel counts the file's whole churn; a node slice counts only its own span.
    const file = node.location.file;
    const startLine = wholeFile ? 1 : node.location.startLine;
    const endLine = wholeFile ? Number.MAX_SAFE_INTEGER : node.location.endLine;
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
  }, [extensions, node, wholeFile]);
}

const EMPTY: ReadonlySet<number> = new Set();
const EMPTY_KINDS: ReadonlyMap<number, ChangedLineKind> = new Map();
