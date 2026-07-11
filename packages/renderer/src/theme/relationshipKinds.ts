/** Catalog-backed relationship filter descriptors. The semantic vocabulary lives in graph/;
 * concrete colour lives in the theme; this adapter keeps toolbar rendering free of either detail. */

import type { LensRelationPolicy } from "../graph/lensRelationPolicy";
import {
  RELATION_CATALOG,
  RELATION_FAMILIES,
  RELATION_KIND_ORDER,
  type RelationFamily,
} from "../graph/relationCatalog";
import { availableRelationKinds } from "../graph/relationVisibility";
import { relationColor } from "./relationTheme";

export interface RelationshipKind {
  key: string;
  label: string;
  color: string;
  family: RelationFamily;
}

export interface RelationshipKindGroup {
  family: RelationFamily;
  label: string;
  kinds: readonly RelationshipKind[];
}

const FAMILY_LABELS: Readonly<Record<RelationFamily, string>> = {
  composition: "Composition",
  inheritance: "Inheritance",
  construction: "Construction",
  behavior: "Behavior",
  dependency: "Dependencies",
  messaging: "Messaging",
  ui: "UI composition",
};

export function relationshipKindsForPolicy(policy: LensRelationPolicy): readonly RelationshipKind[] {
  return availableRelationKinds(policy, RELATION_KIND_ORDER).map((key) => ({
    key,
    label: RELATION_CATALOG[key as keyof typeof RELATION_CATALOG].label,
    family: RELATION_CATALOG[key as keyof typeof RELATION_CATALOG].family,
    color: relationColor(key) ?? "#8B95A3",
  }));
}

export function relationshipKindGroupsForPolicy(policy: LensRelationPolicy): readonly RelationshipKindGroup[] {
  const kinds = relationshipKindsForPolicy(policy);
  return RELATION_FAMILIES.flatMap((family) => {
    const members = kinds.filter((kind) => kind.family === family);
    return members.length > 0 ? [{ family, label: FAMILY_LABELS[family], kinds: members }] : [];
  });
}
