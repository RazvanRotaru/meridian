/**
 * "Which CODE BLOCKS did this PR touch?" — the pure predicate behind the minimal review graph.
 *
 * A changed file names a set of nodes, but showing every node in a 500-line file is not "minimal".
 * So a node is affected only when it BOTH lives in a changed file AND its source range overlaps one
 * of that file's changed line ranges (`ChangedFile.hunks`). When a file carries no hunks — an
 * untracked add, an explicit `--changed` entry, or a diff we couldn't parse — the honest fallback is
 * whole-file: every node in it counts. Overlap uses the post-image line numbers on both sides (the
 * diff's `+` hunks and `node.location`, since we extract the very tree the diff describes).
 *
 * Only real code blocks qualify: `package` and `module` nodes are the file/directory containers the
 * user explicitly does NOT want as the unit, and `ext:`/`unresolved:` pseudo-nodes have no repo file.
 * Lives in core so the renderer graph and any future CLI report share one tested implementation.
 */

import { parseNodeId } from "./ids";
import type { ChangedFile, ChangeStatus, LineRange } from "./review";
import type { GraphNode, NodeId } from "./types";

export interface AffectedNode {
  nodeId: NodeId;
  /** Status of the file the node lives in. */
  status: ChangeStatus;
  file: string;
  /** True when the file carried hunks and this node overlapped one (vs. a whole-file fallback). */
  overlapsHunk: boolean;
}

/** Node kinds that are never a "code block": file/directory containers and boundary pseudo-nodes. */
const NON_BLOCK_KINDS: ReadonlySet<string> = new Set(["package", "module"]);

/**
 * The changed code blocks, sorted file asc → startLine asc → id asc (a stable, readable order for
 * both the graph and any list). A node with no `location.file` in the changed set is skipped.
 */
export function computeAffectedNodes(
  nodes: readonly GraphNode[],
  changedFiles: readonly ChangedFile[],
): AffectedNode[] {
  const statusByFile = new Map(changedFiles.map((file) => [file.path, file.status]));
  const hunksByFile = new Map(changedFiles.map((file) => [file.path, file.hunks]));
  const affected: AffectedNode[] = [];
  for (const node of nodes) {
    if (!isBlockKind(node)) {
      continue;
    }
    const file = node.location.file;
    const status = statusByFile.get(file);
    if (status === undefined) {
      continue;
    }
    const hunks = hunksByFile.get(file);
    const overlap = overlapsAnyHunk(node, hunks);
    if (overlap.hit) {
      affected.push({ nodeId: node.id, status, file, overlapsHunk: overlap.fromHunk });
    }
  }
  return sortAffected(affected);
}

/**
 * Files that changed but contributed NO affected code block: a deletion (its nodes are gone from the
 * freshly-extracted tree), a file the extractor didn't cover, or edits that fell entirely outside any
 * extracted block (e.g. import lines, comments). The renderer lists these so a reviewer never assumes
 * a changed file was silently dropped.
 */
export function unmappedChangedFiles(
  affected: readonly AffectedNode[],
  changedFiles: readonly ChangedFile[],
): ChangedFile[] {
  const covered = new Set(affected.map((node) => node.file));
  return changedFiles.filter((file) => !covered.has(file.path));
}

function isBlockKind(node: GraphNode): boolean {
  if (NON_BLOCK_KINDS.has(node.kind)) {
    return false;
  }
  const lang = parseNodeId(node.id).lang;
  return lang !== "ext" && lang !== "unresolved";
}

/** hit = counts as affected; fromHunk = true only when a real hunk overlapped (not the whole-file fallback). */
function overlapsAnyHunk(
  node: GraphNode,
  hunks: readonly LineRange[] | undefined,
): { hit: boolean; fromHunk: boolean } {
  if (hunks === undefined) {
    return { hit: true, fromHunk: false }; // whole-file fallback
  }
  const start = node.location.startLine;
  const end = node.location.endLine ?? start;
  for (const hunk of hunks) {
    if (start <= hunk.end && end >= hunk.start) {
      return { hit: true, fromHunk: true };
    }
  }
  return { hit: false, fromHunk: false };
}

function sortAffected(affected: AffectedNode[]): AffectedNode[] {
  return affected.sort((a, b) => {
    if (a.file !== b.file) {
      return a.file < b.file ? -1 : 1;
    }
    return a.nodeId < b.nodeId ? -1 : a.nodeId > b.nodeId ? 1 : 0;
  });
}
