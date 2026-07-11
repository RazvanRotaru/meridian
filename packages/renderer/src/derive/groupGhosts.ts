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
  const fileOf = new Map<string, string>();
  const folderCounts = new Map<string, number>();
  for (const id of emission.ghosts.keys()) {
    const file = homeFileOf(id, index);
    const folder = file === null ? null : (index.parentOf.get(file) ?? null);
    if (file !== null && folder !== null) {
      fileOf.set(id, file);
      folderCounts.set(folder, (folderCounts.get(folder) ?? 0) + 1);
    }
  }
  const rewrite = new Map<string, string>();
  // The group card remembers WHICH files contributed, so the "+" pin can promote exactly the files
  // whose symbols it charted — not whatever the folder happens to list first.
  const membersByFolder = new Map<string, Set<string>>();
  for (const [id, file] of fileOf) {
    const folder = index.parentOf.get(file) ?? null;
    if (folder !== null && (folderCounts.get(folder) ?? 0) >= GROUP_THRESHOLD) {
      rewrite.set(id, folder);
      const members = membersByFolder.get(folder) ?? new Set<string>();
      members.add(file);
      membersByFolder.set(folder, members);
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
      members: [...(membersByFolder.get(folder) ?? [])].sort(),
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
      existing.crossPackage ||= wire.crossPackage;
      existing.underlyingEdgeIds.push(...wire.underlyingEdgeIds);
    } else {
      byKey.set(key, {
        source,
        target,
        weight: wire.weight,
        kind: wire.kind,
        crossPackage: wire.crossPackage,
        underlyingEdgeIds: [...wire.underlyingEdgeIds],
      });
    }
  }
  return [...byKey.values()];
}

/** The ghost's home FILE: its nearest module ancestor-or-self; null when it has none (nothing to
 * group under — grouping keys on the file's parent folder). */
function homeFileOf(ghostId: string, index: GraphIndex): string | null {
  const seen = new Set<string>();
  let current: string | null | undefined = ghostId;
  while (current && !seen.has(current)) {
    if (index.nodesById.get(current)?.kind === MODULE_KIND) {
      return current;
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
