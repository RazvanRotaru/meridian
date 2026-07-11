/**
 * Declarative relation policy for graph lenses.
 *
 * A lens decides which semantic relationships tell its story; the shared graph machinery owns the
 * filtering, layout, highways, and boundary ghosts. Rules are resolved by semantic specificity,
 * never array order: exact kind, then catalog family, then the policy fallback.
 */

import {
  RELATION_CATALOG,
  RELATION_FAMILIES,
  RELATION_KIND_ORDER,
} from "./relationCatalog";
import type {
  RelationCatalog,
  RelationFamily,
  RelationKindSpec,
} from "./relationCatalog";

export const RELATION_LAYOUT_ROLES = ["primary", "constraint", "overlay", "ignore"] as const;
export type RelationLayoutRole = (typeof RELATION_LAYOUT_ROLES)[number];

export const RELATION_GHOST_POLICIES = ["boundary", "never"] as const;
export type RelationGhostPolicy = (typeof RELATION_GHOST_POLICIES)[number];

export interface RelationDisposition {
  defaultVisible: boolean;
  layoutRole: RelationLayoutRole;
  /** Relative contribution when eligible wires are merged into a highway. Zero disables it. */
  highwayWeight: number;
  /** Whether an off-scope endpoint may be represented by a boundary ghost. */
  ghostPolicy: RelationGhostPolicy;
}

export type RelationRuleMatch =
  | { kind: string; family?: never }
  | { family: RelationFamily; kind?: never };

export type LensRelationRule = Readonly<RelationDisposition> & {
  readonly match: Readonly<RelationRuleMatch>;
};

export interface LensRelationPolicy {
  id: string;
  rules: readonly LensRelationRule[];
  fallback: Readonly<RelationDisposition>;
}

export type RelationRuleSource = "kind" | "family" | "fallback";

export interface ResolvedRelationPolicy extends RelationDisposition {
  kind: string;
  family: RelationFamily | null;
  matchedBy: RelationRuleSource;
}

/** Preserve literal policy ids and rule values while checking the shared policy contract. */
export function defineLensRelationPolicy<const Policy extends LensRelationPolicy>(policy: Policy): Policy {
  return policy;
}

/** Resolve an exact rule before a family rule, even when the family appears first in the array. */
export function resolveRelationPolicy(
  policy: LensRelationPolicy,
  kind: string,
  catalog: RelationCatalog = RELATION_CATALOG,
): ResolvedRelationPolicy {
  const spec = catalogSpec(catalog, kind);
  const exact = policy.rules.find((rule) => rule.match.kind === kind);
  if (exact) {
    return resolved(kind, spec?.family ?? null, "kind", exact);
  }
  if (spec) {
    const family = policy.rules.find((rule) => rule.match.family === spec.family);
    if (family) {
      return resolved(kind, spec.family, "family", family);
    }
  }
  return resolved(kind, spec?.family ?? null, "fallback", policy.fallback);
}

export function isRelationVisible(
  policy: LensRelationPolicy,
  kind: string,
  catalog: RelationCatalog = RELATION_CATALOG,
): boolean {
  return resolveRelationPolicy(policy, kind, catalog).defaultVisible;
}

/** Only primary and constraint relationships shape ELK; overlays are paint-only when enabled. */
export function relationParticipatesInLayout(
  policy: LensRelationPolicy,
  kind: string,
  catalog: RelationCatalog = RELATION_CATALOG,
): boolean {
  const role = resolveRelationPolicy(policy, kind, catalog).layoutRole;
  return role === "primary" || role === "constraint";
}

export function isRelationRelevant(
  policy: LensRelationPolicy,
  kind: string,
  catalog: RelationCatalog = RELATION_CATALOG,
): boolean {
  return resolveRelationPolicy(policy, kind, catalog).layoutRole !== "ignore";
}

export function relationHighwayWeight(
  policy: LensRelationPolicy,
  kind: string,
  catalog: RelationCatalog = RELATION_CATALOG,
): number {
  return resolveRelationPolicy(policy, kind, catalog).highwayWeight;
}

export function relationGhostPolicy(
  policy: LensRelationPolicy,
  kind: string,
  catalog: RelationCatalog = RELATION_CATALOG,
): RelationGhostPolicy {
  return resolveRelationPolicy(policy, kind, catalog).ghostPolicy;
}

/** The kinds a lens can offer in filters, including default-hidden overlays but excluding ignores. */
export function relevantRelationKinds(
  policy: LensRelationPolicy,
  kinds: readonly string[] = RELATION_KIND_ORDER,
  catalog: RelationCatalog = RELATION_CATALOG,
): readonly string[] {
  return kinds.filter((kind) => isRelationRelevant(policy, kind, catalog));
}

export interface RelationFamilyGroup {
  /** Null is the open-vocabulary bucket for kinds absent from the supplied catalog. */
  family: RelationFamily | null;
  kinds: readonly string[];
}

/** Group filterable kinds in stable family order, with unknown exact-rule kinds last. */
export function groupRelevantRelationKinds(
  policy: LensRelationPolicy,
  kinds: readonly string[] = RELATION_KIND_ORDER,
  catalog: RelationCatalog = RELATION_CATALOG,
): readonly RelationFamilyGroup[] {
  const grouped = new Map<RelationFamily | null, string[]>();
  for (const kind of relevantRelationKinds(policy, kinds, catalog)) {
    const family = catalogSpec(catalog, kind)?.family ?? null;
    const group = grouped.get(family);
    if (group) {
      group.push(kind);
    } else {
      grouped.set(family, [kind]);
    }
  }
  return [...RELATION_FAMILIES, null]
    .filter((family) => grouped.has(family))
    .map((family) => ({ family, kinds: grouped.get(family) as string[] }));
}

const IGNORED: Readonly<RelationDisposition> = {
  defaultVisible: false,
  layoutRole: "ignore",
  highwayWeight: 0,
  ghostPolicy: "never",
};

const MAP_PRIMARY: Readonly<RelationDisposition> = {
  defaultVisible: true,
  layoutRole: "primary",
  highwayWeight: 1,
  ghostPolicy: "boundary",
};

/** The folder Map keeps the dependency vocabulary it already renders; other lens stories stay out. */
export const MAP_RELATION_POLICY = defineLensRelationPolicy({
  id: "map",
  rules: [
    { match: { family: "inheritance" }, ...MAP_PRIMARY },
    { match: { family: "construction" }, ...MAP_PRIMARY },
    { match: { family: "behavior" }, ...MAP_PRIMARY },
    { match: { family: "dependency" }, ...MAP_PRIMARY },
    { match: { family: "messaging" }, ...MAP_PRIMARY },
  ],
  fallback: IGNORED,
});

/** Service structure drives placement; behavioral and incidental dependencies are opt-in paint. */
export const SERVICE_RELATION_POLICY = defineLensRelationPolicy({
  id: "service",
  rules: [
    {
      match: { family: "composition" },
      defaultVisible: true,
      layoutRole: "primary",
      highwayWeight: 5,
      ghostPolicy: "boundary",
    },
    {
      match: { family: "inheritance" },
      defaultVisible: true,
      layoutRole: "constraint",
      highwayWeight: 3,
      ghostPolicy: "boundary",
    },
    {
      match: { family: "construction" },
      defaultVisible: true,
      layoutRole: "constraint",
      highwayWeight: 2,
      ghostPolicy: "boundary",
    },
    {
      match: { family: "behavior" },
      defaultVisible: false,
      layoutRole: "overlay",
      highwayWeight: 1,
      ghostPolicy: "boundary",
    },
    {
      match: { family: "dependency" },
      defaultVisible: false,
      layoutRole: "overlay",
      highwayWeight: 1,
      ghostPolicy: "boundary",
    },
    {
      match: { family: "messaging" },
      defaultVisible: false,
      layoutRole: "overlay",
      highwayWeight: 1,
      ghostPolicy: "boundary",
    },
  ],
  fallback: IGNORED,
});

const UI_OVERLAY: Readonly<RelationDisposition> = {
  defaultVisible: false,
  layoutRole: "overlay",
  highwayWeight: 1,
  ghostPolicy: "boundary",
};

/** Render composition is primary; expanded-code relationships remain available without moving it. */
export const UI_RELATION_POLICY = defineLensRelationPolicy({
  id: "ui",
  rules: [
    {
      match: { kind: "renders" },
      defaultVisible: true,
      layoutRole: "primary",
      highwayWeight: 5,
      ghostPolicy: "boundary",
    },
    {
      match: { family: "inheritance" },
      defaultVisible: true,
      layoutRole: "constraint",
      highwayWeight: 2,
      ghostPolicy: "boundary",
    },
    { match: { family: "composition" }, ...UI_OVERLAY },
    { match: { family: "construction" }, ...UI_OVERLAY },
    { match: { family: "behavior" }, ...UI_OVERLAY },
    { match: { family: "dependency" }, ...UI_OVERLAY },
    { match: { family: "messaging" }, ...UI_OVERLAY },
  ],
  fallback: IGNORED,
});

export const BUILT_IN_LENS_RELATION_POLICIES = {
  map: MAP_RELATION_POLICY,
  service: SERVICE_RELATION_POLICY,
  ui: UI_RELATION_POLICY,
} as const;

export type BuiltInRelationLens = keyof typeof BUILT_IN_LENS_RELATION_POLICIES;

export function relationPolicyForLens(lens: BuiltInRelationLens): LensRelationPolicy {
  return BUILT_IN_LENS_RELATION_POLICIES[lens];
}

function catalogSpec(catalog: RelationCatalog, kind: string): Readonly<RelationKindSpec> | undefined {
  return Object.prototype.hasOwnProperty.call(catalog, kind) ? catalog[kind] : undefined;
}

function resolved(
  kind: string,
  family: RelationFamily | null,
  matchedBy: RelationRuleSource,
  disposition: Readonly<RelationDisposition>,
): ResolvedRelationPolicy {
  return {
    kind,
    family,
    matchedBy,
    defaultVisible: disposition.defaultVisible,
    layoutRole: disposition.layoutRole,
    highwayWeight: disposition.highwayWeight,
    ghostPolicy: disposition.ghostPolicy,
  };
}
