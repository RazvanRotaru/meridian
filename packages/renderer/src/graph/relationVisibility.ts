/**
 * Immutable per-lens visibility overrides over declarative relation-policy defaults.
 *
 * The record is sparse: a missing exact kind means "follow the policy". Returning a kind to its
 * default deletes its entry, and resetting one lens never disturbs another lens's preferences.
 */

import { RELATION_CATALOG } from "./relationCatalog";
import type { RelationCatalog } from "./relationCatalog";
import {
  isRelationRelevant,
  isRelationVisible,
} from "./lensRelationPolicy";
import type { LensRelationPolicy } from "./lensRelationPolicy";

export type RelationKindVisibilityOverrides = Readonly<Record<string, boolean>>;

export type RelationVisibilityOverrides<LensId extends string = string> = Readonly<
  Partial<Record<LensId, RelationKindVisibilityOverrides>>
>;

export const EMPTY_RELATION_VISIBILITY_OVERRIDES: RelationVisibilityOverrides = Object.freeze({});

type PolicyFor<LensId extends string> = LensRelationPolicy & { readonly id: LensId };

/**
 * A catalog kind is available when the resolved policy does not ignore it. An open-vocabulary kind
 * requires an exact relevant rule: a permissive fallback alone must not mint a new filter control.
 */
export function isRelationAvailable<LensId extends string>(
  policy: PolicyFor<LensId>,
  kind: string,
  catalog: RelationCatalog = RELATION_CATALOG,
): boolean {
  const exact = policy.rules.find((rule) => rule.match.kind === kind);
  if (exact) {
    return exact.layoutRole !== "ignore";
  }
  return catalogHas(catalog, kind) && isRelationRelevant(policy, kind, catalog);
}

export function isRelationShown<PolicyId extends string, OverrideId extends string>(
  policy: PolicyFor<PolicyId>,
  overrides: RelationVisibilityOverrides<OverrideId>,
  kind: string,
  catalog: RelationCatalog = RELATION_CATALOG,
): boolean {
  if (!isRelationAvailable(policy, kind, catalog)) {
    return false;
  }
  const lensOverrides = (overrides as RelationVisibilityOverrides)[policy.id];
  return lensOverrides && hasOwn(lensOverrides, kind)
    ? lensOverrides[kind]
    : isRelationVisible(policy, kind, catalog);
}

/** Available exact kinds, in caller/catalog order, followed by policy-declared custom kinds. */
export function availableRelationKinds<LensId extends string>(
  policy: PolicyFor<LensId>,
  kinds: readonly string[] | undefined = undefined,
  catalog: RelationCatalog = RELATION_CATALOG,
): readonly string[] {
  const exactKinds = policy.rules.flatMap((rule) => rule.match.kind ? [rule.match.kind] : []);
  return unique([...(kinds ?? Object.keys(catalog)), ...exactKinds])
    .filter((kind) => isRelationAvailable(policy, kind, catalog));
}

export function hiddenRelationKinds<PolicyId extends string, OverrideId extends string>(
  policy: PolicyFor<PolicyId>,
  overrides: RelationVisibilityOverrides<OverrideId>,
  kinds: readonly string[] | undefined = undefined,
  catalog: RelationCatalog = RELATION_CATALOG,
): readonly string[] {
  return availableRelationKinds(policy, kinds, catalog)
    .filter((kind) => !isRelationShown(policy, overrides, kind, catalog));
}

/** Toggle one exact kind. Toggling back to the policy default removes the sparse override. */
export function toggleRelationOverride<PolicyId extends string, OverrideId extends string>(
  policy: PolicyFor<PolicyId>,
  overrides: RelationVisibilityOverrides<OverrideId>,
  kind: string,
  catalog: RelationCatalog = RELATION_CATALOG,
): RelationVisibilityOverrides<PolicyId | OverrideId> {
  if (!isRelationAvailable(policy, kind, catalog)) {
    return overrides as RelationVisibilityOverrides<PolicyId | OverrideId>;
  }
  return setRelationShown(
    policy,
    overrides as RelationVisibilityOverrides,
    kind,
    !isRelationShown(policy, overrides, kind, catalog),
    catalog,
  ) as RelationVisibilityOverrides<PolicyId | OverrideId>;
}

/** Show every available kind; policy-default-visible kinds need no stored override. */
export function showAllRelations<PolicyId extends string, OverrideId extends string>(
  policy: PolicyFor<PolicyId>,
  overrides: RelationVisibilityOverrides<OverrideId>,
  kinds: readonly string[] | undefined = undefined,
  catalog: RelationCatalog = RELATION_CATALOG,
): RelationVisibilityOverrides<PolicyId | OverrideId> {
  let next: RelationVisibilityOverrides = overrides;
  for (const kind of availableRelationKinds(policy, kinds, catalog)) {
    next = setRelationShown(policy, next, kind, true, catalog);
  }
  return next as RelationVisibilityOverrides<PolicyId | OverrideId>;
}

/** Drop one lens's deviations so every exact kind follows its policy default again. */
export function resetRelationsToPolicyDefaults<PolicyId extends string, OverrideId extends string>(
  policy: PolicyFor<PolicyId>,
  overrides: RelationVisibilityOverrides<OverrideId>,
): RelationVisibilityOverrides<OverrideId> {
  if (!hasOwn(overrides, policy.id)) {
    return overrides;
  }
  const next: Record<string, RelationKindVisibilityOverrides | undefined> = { ...overrides };
  delete next[policy.id];
  return next as RelationVisibilityOverrides<OverrideId>;
}

function setRelationShown(
  policy: LensRelationPolicy,
  overrides: RelationVisibilityOverrides,
  kind: string,
  shown: boolean,
  catalog: RelationCatalog,
): RelationVisibilityOverrides {
  if (!isRelationAvailable(policy, kind, catalog)) {
    return overrides;
  }
  const followsDefault = shown === isRelationVisible(policy, kind, catalog);
  const current = overrides[policy.id] ?? {};
  if (followsDefault) {
    if (!hasOwn(current, kind)) {
      return overrides;
    }
    const nextLens: Record<string, boolean> = { ...current };
    delete nextLens[kind];
    return replaceLensOverrides(policy.id, overrides, nextLens);
  }
  if (current[kind] === shown && hasOwn(current, kind)) {
    return overrides;
  }
  return replaceLensOverrides(policy.id, overrides, { ...current, [kind]: shown });
}

function replaceLensOverrides(
  lensId: string,
  overrides: RelationVisibilityOverrides,
  lensOverrides: RelationKindVisibilityOverrides,
): RelationVisibilityOverrides {
  if (Object.keys(lensOverrides).length > 0) {
    return { ...overrides, [lensId]: lensOverrides };
  }
  const next: Record<string, RelationKindVisibilityOverrides | undefined> = { ...overrides };
  delete next[lensId];
  return next as RelationVisibilityOverrides;
}

function catalogHas(catalog: RelationCatalog, kind: string): boolean {
  return Object.prototype.hasOwnProperty.call(catalog, kind);
}

function hasOwn(record: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}
