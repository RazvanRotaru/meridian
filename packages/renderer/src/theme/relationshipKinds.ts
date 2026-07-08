/**
 * The toggleable relationship kinds of the Map's wires, in one place so the toggles, the legend, and
 * the paint layer all agree on the key → label → colour mapping. `imports` and `ipc` are whole
 * categories; the rest are code-dependency `depKind`s. Execution-order (flow) wires are structural,
 * not a relationship, so they are never toggled.
 */

import { IPC_WIRE } from "./edgeColors";
import { IMPORT_CROSS, REL_COLORS } from "./mapPalette";

export interface RelationshipKind {
  key: string;
  label: string;
  color: string;
}

export const RELATIONSHIP_KINDS: RelationshipKind[] = [
  { key: "calls", label: "Calls", color: REL_COLORS.calls },
  { key: "instantiates", label: "Constructs", color: REL_COLORS.instantiates },
  { key: "extends", label: "Extends", color: REL_COLORS.extends },
  { key: "implements", label: "Implements", color: REL_COLORS.implements },
  { key: "references", label: "References", color: REL_COLORS.references },
  { key: "imports", label: "Imports", color: IMPORT_CROSS },
  { key: "ipc", label: "IPC", color: IPC_WIRE },
];
