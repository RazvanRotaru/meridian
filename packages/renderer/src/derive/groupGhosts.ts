/**
 * Ghost GROUPING — the Highways treatment for the ghost tier. A busy level can attract dozens of
 * off-level ghost cards that all live in the same off-screen folder (every `*.test.ts` under
 * `tests/vscode/host` poking at `Bridge.ts`): one fact drawn N times. Fold them: ghosts whose home
 * folder contributes ≥ threshold cards collapse into ONE group card carrying that FOLDER's real id
 * (never a parallel id — so selection, emphasis, the Tests toggle's containment-closed testIds, and
 * double-click-to-navigate all work unchanged), and their wires re-aggregate per (source, target,
 * kind) with summed weights. A folder contributing ONE ghost keeps it individual — a lone ghost's
 * symbol name is worth more than a "1 symbol" group.
 */

import type { GraphIndex } from "../graph/graphIndex";
import type { GhostEmission, GhostWire } from "./ghostDeps";

const MODULE_KIND = "module";

/** Minimum ghosts from one folder before they fold into a group card. */
const GROUP_THRESHOLD = 2;

export function groupGhostEmission(emission: GhostEmission, index: GraphIndex): GhostEmission {
  // Tally each ghost's home folder; ghosts without one (a root-level file's symbol) stay individual.
  const folderOf = new Map<string, string>();
  const folderCounts = new Map<string, number>();
  for (const id of emission.ghosts.keys()) {
    const folder = homeFolderOf(id, index);
    if (folder !== null) {
      folderOf.set(id, folder);
      folderCounts.set(folder, (folderCounts.get(folder) ?? 0) + 1);
    }
  }
  const rewrite = new Map<string, string>();
  for (const [id, folder] of folderOf) {
    if ((folderCounts.get(folder) ?? 0) >= GROUP_THRESHOLD) {
      rewrite.set(id, folder);
    }
  }
  if (rewrite.size === 0) {
    return emission;
  }
  const ghosts = new Map(emission.ghosts);
  for (const [id, folder] of rewrite) {
    ghosts.delete(id);
    ghosts.set(folder, {
      label: folderLabel(folder, index),
      context: `${folderCounts.get(folder)} referenced symbols — double-click to open`,
      ghostKind: "package",
    });
  }
  return { ghosts, wires: aggregateWires(emission.wires, rewrite) };
}

/** Re-key each wire through the ghost→group rewrite, then fold duplicates by (source, target, kind). */
function aggregateWires(wires: readonly GhostWire[], rewrite: ReadonlyMap<string, string>): GhostWire[] {
  const byKey = new Map<string, GhostWire>();
  for (const wire of wires) {
    const source = rewrite.get(wire.source) ?? wire.source;
    const target = rewrite.get(wire.target) ?? wire.target;
    const key = `${source} ${target} ${wire.kind}`;
    const existing = byKey.get(key);
    if (existing) {
      existing.weight += wire.weight;
    } else {
      byKey.set(key, { source, target, weight: wire.weight, kind: wire.kind });
    }
  }
  return [...byKey.values()];
}

/** The ghost's home FOLDER: parent of the nearest module (file) ancestor-or-self; null when the
 * file sits at the containment root (nothing to group under). */
function homeFolderOf(ghostId: string, index: GraphIndex): string | null {
  const seen = new Set<string>();
  let current: string | null | undefined = ghostId;
  while (current && !seen.has(current)) {
    if (index.nodesById.get(current)?.kind === MODULE_KIND) {
      return index.parentOf.get(current) ?? null;
    }
    seen.add(current);
    current = index.parentOf.get(current) ?? null;
  }
  return null;
}

/** The folder's path as the card label (`src/packages/tests/vscode/host`), not just its basename —
 * a detached ghost needs the full context its position can't give. */
function folderLabel(folderId: string, index: GraphIndex): string {
  const node = index.nodesById.get(folderId);
  const hash = folderId.indexOf(":");
  return node?.qualifiedName ?? (hash === -1 ? folderId : folderId.slice(hash + 1));
}
