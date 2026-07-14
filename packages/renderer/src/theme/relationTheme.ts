/**
 * Theme realization of the semantic relation catalog. The catalog names visual roles; this module
 * is the single place that turns those roles into concrete strokes. Lenses never choose colours or
 * dash arrays themselves, so Map, Service, UI, ghosts, ribbons, and highways cannot drift.
 */

import type { Edge } from "@xyflow/react";
import { relationSpec, type RelationStyleToken } from "../graph/relationCatalog";
import { relationKindOf } from "../graph/relationEdge";
import { isDashedBoundary } from "../layout/edgeBoundary";
import { IPC_WIRE, RENDERS_WIRE } from "./edgeColors";
import { IMPORT_CROSS, REL_COLORS } from "./mapPalette";

const TOKEN_COLORS: Readonly<Record<RelationStyleToken, string>> = {
  composition: "#4AA77A",
  inheritance: REL_COLORS.extends,
  construction: REL_COLORS.instantiates,
  call: REL_COLORS.calls,
  reference: REL_COLORS.references,
  import: IMPORT_CROSS,
  ipc: IPC_WIRE,
  render: RENDERS_WIRE,
};

/** Exact-kind overrides keep extends/implements distinguishable while sharing an inheritance role. */
const EXACT_COLORS: Readonly<Record<string, string>> = {
  extends: REL_COLORS.extends,
  implements: REL_COLORS.implements,
  implementedBy: REL_COLORS.implementedBy,
};

export function relationColor(kind: string | null | undefined): string | null {
  if (!kind) return null;
  const exact = EXACT_COLORS[kind];
  if (exact) return exact;
  const token = relationSpec(kind)?.styleToken;
  return token ? TOKEN_COLORS[token] : null;
}
/** Line shape carries relation family independently of colour. A package/view boundary retains the
 * canonical boundary dash because crossing ownership is the stronger local fact. */
export function withRelationLineStyle(style: Edge["style"], data: unknown): Edge["style"] {
  if (isDashedBoundary(data)) return style;
  const kind = relationKindOf(data as Parameters<typeof relationKindOf>[0]);
  const token = kind ? relationSpec(kind)?.styleToken : undefined;
  if (token === "inheritance") return { ...style, strokeDasharray: "3 3" };
  if (token === "ipc") return { ...style, strokeDasharray: "8 3 2 3" };
  return style;
}
