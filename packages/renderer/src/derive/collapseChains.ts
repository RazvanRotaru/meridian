/**
 * Collapse maximal chains of directory (`package`) nodes that have exactly ONE kept child into a
 * single frame labeled with the joined path segments (e.g. `packages/renderer/src/derive`). A lone
 * `src → derive → …` ladder is visual noise, so it folds into one box. Computed over the KEPT
 * containment subtree (after the ancestor union + boundary insertion), never the whole graph. Pure.
 *
 * The DEEPEST package of a chain is the representative that survives (its children already point at
 * it); every pass-through ancestor above it is `absorbed` and dropped. Effective parents skip over
 * absorbed nodes so the surviving tree stays connected.
 */

import type { GraphIndex } from "../graph/graphIndex";

const PACKAGE_KIND = "package";

export interface ChainCollapse {
  /** Pass-through package ids merged into a deeper frame — omit these from the spec. */
  absorbed: Set<string>;
  /** Collapsed frame label (`a/b/c`) for each representative that absorbed >=1 ancestor. */
  labelById: Map<string, string>;
  /** Effective parent (nearest surviving kept ancestor) for each surviving kept node; null at root. */
  parentById: Map<string, string | null>;
}

export function collapseChains(index: GraphIndex, keptNodeIds: ReadonlySet<string>): ChainCollapse {
  const absorbed = passThroughPackages(index, keptNodeIds);
  const labelById = new Map<string, string>();
  const parentById = new Map<string, string | null>();
  for (const id of keptNodeIds) {
    if (absorbed.has(id)) {
      continue;
    }
    parentById.set(id, survivingParent(id, index, absorbed));
    const label = chainLabel(id, index, absorbed);
    if (label !== null) {
      labelById.set(id, label);
    }
  }
  return { absorbed, labelById, parentById };
}

/** A package is pass-through when its only kept child is itself a package (a wasted level). */
function passThroughPackages(index: GraphIndex, keptNodeIds: ReadonlySet<string>): Set<string> {
  const absorbed = new Set<string>();
  for (const id of keptNodeIds) {
    if (index.nodesById.get(id)?.kind === PACKAGE_KIND && isPassThrough(id, index, keptNodeIds)) {
      absorbed.add(id);
    }
  }
  return absorbed;
}

function isPassThrough(id: string, index: GraphIndex, keptNodeIds: ReadonlySet<string>): boolean {
  const keptChildren = index.childrenOf(id).filter((child) => keptNodeIds.has(child.id));
  return keptChildren.length === 1 && keptChildren[0].kind === PACKAGE_KIND;
}

/** The nearest ancestor that survives (isn't absorbed); null at the root. Cycle-guarded. */
function survivingParent(id: string, index: GraphIndex, absorbed: ReadonlySet<string>): string | null {
  const seen = new Set<string>([id]);
  let current = index.parentOf.get(id) ?? null;
  while (current !== null && !seen.has(current)) {
    if (!absorbed.has(current)) {
      return current;
    }
    seen.add(current);
    current = index.parentOf.get(current) ?? null;
  }
  return null;
}

/** Join the basenames of the absorbed chain above a rep plus the rep itself; null when none absorbed. */
function chainLabel(repId: string, index: GraphIndex, absorbed: ReadonlySet<string>): string | null {
  const chain: string[] = [];
  const seen = new Set<string>([repId]);
  let current = index.parentOf.get(repId) ?? null;
  while (current !== null && absorbed.has(current) && !seen.has(current)) {
    chain.push(current);
    seen.add(current);
    current = index.parentOf.get(current) ?? null;
  }
  if (chain.length === 0) {
    return null;
  }
  return [...chain.reverse(), repId].map((id) => basenameOf(index, id)).join("/");
}

function basenameOf(index: GraphIndex, id: string): string {
  return index.nodesById.get(id)?.displayName ?? id;
}
