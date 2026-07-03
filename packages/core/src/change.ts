/**
 * The change-lens overlay contract (`change/1.0`): what a git range did to the graph.
 *
 * Exactly like the telemetry overlay, it joins on `node.id` — the graph artifact stays a pure
 * structure snapshot and the diff is painted on top. `nodes` carries only nodes the range
 * actually touched (functions, methods, classes, modules); containers are NOT pre-aggregated —
 * the renderer rolls up through `parentId` so collapsed boxes always reflect what is visible.
 *
 * `repoRoot`/`prefix`/`range` make the overlay self-describing enough for a local server to
 * stream real unified diffs on demand (`/api/file-diff`) without re-deriving anything.
 */

export type ChangeStatus = "added" | "modified" | "removed";

export interface NodeChange {
  status: ChangeStatus;
  additions: number;
  deletions: number;
}

export interface FileChange {
  status: ChangeStatus;
  additions: number;
  deletions: number;
}

export interface ChangeOverlay {
  schemaVersion: "change/1.0";
  /** The exact git revision range the overlay was minted from, e.g. "6033f95..fc5bac9". */
  range: string;
  /** Absolute path of the git repository the range refers to (local serve only). */
  repoRoot: string;
  /** Path from `repoRoot` to the extracted target root; "" when they coincide. */
  prefix: string;
  generatedAt: string;
  /** node.id -> change, for every artifact node whose source span the range touched. */
  nodes: Record<string, NodeChange>;
  /** target-relative file path -> whole-file change totals (includes files with no mapped node). */
  files: Record<string, FileChange>;
}

export function isChangeOverlay(value: unknown): value is ChangeOverlay {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const overlay = value as Partial<ChangeOverlay>;
  return (
    overlay.schemaVersion === "change/1.0" &&
    typeof overlay.range === "string" &&
    typeof overlay.repoRoot === "string" &&
    typeof overlay.prefix === "string" &&
    typeof overlay.nodes === "object" &&
    overlay.nodes !== null &&
    typeof overlay.files === "object" &&
    overlay.files !== null
  );
}
