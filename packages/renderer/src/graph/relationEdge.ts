/**
 * The one compatibility boundary between canonical relation kinds and the Module canvas's historic
 * `category` / `depKind` payload. New code writes `relationKind`; readers accept the legacy shape
 * while the shared graph pipeline migrates. A kindless dependency is deliberately UNKNOWN — never
 * silently reclassified as a call.
 */

export interface RelationEdgeLike {
  relationKind?: unknown;
  depKind?: unknown;
  category?: unknown;
  dominantKind?: unknown;
}

/** Resolve the exact semantic kind from either a tree edge or React Flow edge-data payload. */
export function relationKindOf(value: RelationEdgeLike | null | undefined): string | null {
  if (!value) return null;
  if (typeof value.relationKind === "string" && value.relationKind.length > 0) return value.relationKind;
  if (typeof value.depKind === "string" && value.depKind.length > 0) return value.depKind;
  if (typeof value.dominantKind === "string" && value.dominantKind.length > 0) return value.dominantKind;
  return categoryRelationKind(value.category);
}

/** Whole-category relationships use historic singular category keys on ModuleTreeEdge. */
function categoryRelationKind(category: unknown): string | null {
  if (category === "import" || category === "imports") return "imports";
  if (category === "ipc") return "ipc";
  // `dep` without a kind is malformed/unknown, and `flow` is execution order rather than a
  // source-level relationship. Neither is allowed to masquerade as Calls.
  return null;
}

/** Add the canonical field while retaining `depKind` during the compatibility window. */
export function withRelationKind<T extends RelationEdgeLike>(value: T, relationKind: string): T & {
  relationKind: string;
  depKind: string;
} {
  return { ...value, relationKind, depKind: relationKind };
}
