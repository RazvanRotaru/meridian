/**
 * The renderer's semantic relationship vocabulary.
 *
 * Relation kinds stay flat and stable because they are persisted in artifacts, URLs, and edge
 * evidence. Families are the coarse switches a lens policy uses for filtering and layout; style
 * tokens are theme-facing visual roles. Neither is encoded into the kind string.
 */

export const RELATION_FAMILIES = [
  "composition",
  "inheritance",
  "construction",
  "behavior",
  "dependency",
  "messaging",
  "ui",
] as const;

export type RelationFamily = (typeof RELATION_FAMILIES)[number];

/** Visual roles, not colours or stroke declarations. A theme owns their concrete appearance. */
export const RELATION_STYLE_TOKENS = [
  "composition",
  "inheritance",
  "construction",
  "call",
  "reference",
  "import",
  "ipc",
  "render",
] as const;

export type RelationStyleToken = (typeof RELATION_STYLE_TOKENS)[number];

export interface RelationKindSpec {
  label: string;
  family: RelationFamily;
  styleToken: RelationStyleToken;
}

/** A catalog may add domain-specific kinds, but each one reuses the renderer's semantic grammar. */
export type RelationCatalog<Kind extends string = string> = Readonly<
  Record<Kind, Readonly<RelationKindSpec>>
>;

/** Preserve literal keys and values while checking a catalog against the shared contract. */
export function defineRelationCatalog<const Catalog extends RelationCatalog>(catalog: Catalog): Catalog {
  return catalog;
}

/** Stable order for legends and exact-kind filter controls. */
export const RELATION_KIND_ORDER = [
  "registers",
  "binds",
  "provides",
  "injects",
  "owns",
  "aliases",
  "extends",
  "implements",
  "implementedBy",
  "instantiates",
  "calls",
  "createsPromise",
  "returnsPromise",
  "awaitsPromise",
  "resolvesPromise",
  "rejectsPromise",
  "references",
  "imports",
  "sends",
  "handles",
  "ipc",
  "renders",
] as const;

export type RelationKind = (typeof RELATION_KIND_ORDER)[number];

export const RELATION_CATALOG = defineRelationCatalog({
  registers: { label: "Registers", family: "composition", styleToken: "composition" },
  binds: { label: "Binds", family: "composition", styleToken: "composition" },
  provides: { label: "Provides", family: "composition", styleToken: "composition" },
  injects: { label: "Injects", family: "composition", styleToken: "composition" },
  owns: { label: "Owns", family: "composition", styleToken: "composition" },
  aliases: { label: "Aliases", family: "composition", styleToken: "composition" },
  extends: { label: "Extends", family: "inheritance", styleToken: "inheritance" },
  implements: { label: "Implements", family: "inheritance", styleToken: "inheritance" },
  implementedBy: { label: "Implemented by", family: "inheritance", styleToken: "inheritance" },
  instantiates: { label: "Instantiates", family: "construction", styleToken: "construction" },
  calls: { label: "Calls", family: "behavior", styleToken: "call" },
  createsPromise: { label: "Creates promise", family: "behavior", styleToken: "call" },
  returnsPromise: { label: "Returns promise", family: "behavior", styleToken: "call" },
  awaitsPromise: { label: "Awaits promise", family: "behavior", styleToken: "call" },
  resolvesPromise: { label: "Resolves promise", family: "behavior", styleToken: "call" },
  rejectsPromise: { label: "Rejects promise", family: "behavior", styleToken: "call" },
  references: { label: "References", family: "dependency", styleToken: "reference" },
  imports: { label: "Imports", family: "dependency", styleToken: "import" },
  sends: { label: "Sends", family: "messaging", styleToken: "ipc" },
  handles: { label: "Handles", family: "messaging", styleToken: "ipc" },
  ipc: { label: "IPC", family: "messaging", styleToken: "ipc" },
  renders: { label: "Renders", family: "ui", styleToken: "render" },
} satisfies RelationCatalog<RelationKind>);

export function isRelationKind(kind: string): kind is RelationKind {
  return Object.prototype.hasOwnProperty.call(RELATION_CATALOG, kind);
}

/** Unknown/open-vocabulary artifact kinds remain valid input; they simply have no built-in spec. */
export function relationSpec(kind: string): Readonly<RelationKindSpec> | undefined {
  return isRelationKind(kind) ? RELATION_CATALOG[kind] : undefined;
}

/** Return built-in kinds in their stable display order. */
export function relationKindsForFamily(family: RelationFamily): readonly RelationKind[] {
  return RELATION_KIND_ORDER.filter((kind) => RELATION_CATALOG[kind].family === family);
}
