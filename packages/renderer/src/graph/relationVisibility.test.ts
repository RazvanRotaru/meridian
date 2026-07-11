import { describe, expect, expectTypeOf, it } from "vitest";
import { defineRelationCatalog } from "./relationCatalog";
import {
  MAP_RELATION_POLICY,
  SERVICE_RELATION_POLICY,
  UI_RELATION_POLICY,
  defineLensRelationPolicy,
} from "./lensRelationPolicy";
import {
  EMPTY_RELATION_VISIBILITY_OVERRIDES,
  availableRelationKinds,
  hiddenRelationKinds,
  isRelationAvailable,
  isRelationShown,
  resetRelationsToPolicyDefaults,
  showAllRelations,
  toggleRelationOverride,
} from "./relationVisibility";
import type { RelationVisibilityOverrides } from "./relationVisibility";

const FALLBACK = {
  defaultVisible: false,
  layoutRole: "ignore",
  highwayWeight: 0,
  ghostPolicy: "never",
} as const;

describe("relation visibility", () => {
  it("reads exact per-lens overrides over independent policy defaults", () => {
    const overrides: RelationVisibilityOverrides<"map" | "service"> = {
      map: { calls: false },
      service: { calls: true },
    };
    expect(isRelationShown(MAP_RELATION_POLICY, overrides, "calls")).toBe(false);
    expect(isRelationShown(SERVICE_RELATION_POLICY, overrides, "calls")).toBe(true);
    expect(isRelationShown(SERVICE_RELATION_POLICY, overrides, "registers")).toBe(true);
    expect(isRelationShown(UI_RELATION_POLICY, {}, "renders")).toBe(true);
  });

  it("never surfaces ignored or unknown kinds through a boolean override", () => {
    const overrides = { service: { renders: true, mystery: true } } as const;
    expect(isRelationAvailable(SERVICE_RELATION_POLICY, "renders")).toBe(false);
    expect(isRelationAvailable(SERVICE_RELATION_POLICY, "mystery")).toBe(false);
    expect(isRelationShown(SERVICE_RELATION_POLICY, overrides, "renders")).toBe(false);
    expect(isRelationShown(SERVICE_RELATION_POLICY, overrides, "mystery")).toBe(false);
    expect(toggleRelationOverride(SERVICE_RELATION_POLICY, overrides, "mystery")).toBe(overrides);
  });

  it("allows an unknown kind only when the policy declares an exact relevant rule", () => {
    const custom = defineLensRelationPolicy({
      id: "custom-lens",
      rules: [
        {
          match: { kind: "navigates" },
          defaultVisible: true,
          layoutRole: "overlay",
          highwayWeight: 1,
          ghostPolicy: "boundary",
        },
      ],
      fallback: {
        // Deliberately permissive: this still must not make arbitrary unknown kinds available.
        defaultVisible: true,
        layoutRole: "primary",
        highwayWeight: 1,
        ghostPolicy: "boundary",
      },
    });
    expect(isRelationAvailable(custom, "navigates")).toBe(true);
    expect(isRelationShown(custom, {}, "navigates")).toBe(true);
    expect(isRelationAvailable(custom, "arbitrary")).toBe(false);
    expect(isRelationShown(custom, { "custom-lens": { arbitrary: true } }, "arbitrary")).toBe(false);
  });

  it("uses a supplied catalog as the default candidate vocabulary", () => {
    const customCatalog = defineRelationCatalog({
      invokes: { label: "Invokes", family: "behavior", styleToken: "call" },
    });
    expect(availableRelationKinds(SERVICE_RELATION_POLICY, undefined, customCatalog)).toEqual(["invokes"]);
  });
});

describe("immutable override operations", () => {
  it("toggles deviations and removes an override when it returns to the policy default", () => {
    const otherLens = { map: { calls: false } } as const;
    const shown = toggleRelationOverride(SERVICE_RELATION_POLICY, otherLens, "calls");
    expect(shown).toEqual({ map: { calls: false }, service: { calls: true } });
    expect(otherLens).toEqual({ map: { calls: false } });

    const restored = toggleRelationOverride(SERVICE_RELATION_POLICY, shown, "calls");
    expect(restored).toEqual(otherLens);
    expect(restored.service).toBeUndefined();
  });

  it("can hide a default-visible kind and compact it again on the second toggle", () => {
    const hidden = toggleRelationOverride(SERVICE_RELATION_POLICY, {}, "registers");
    expect(hidden).toEqual({ service: { registers: false } });
    expect(isRelationShown(SERVICE_RELATION_POLICY, hidden, "registers")).toBe(false);
    expect(toggleRelationOverride(SERVICE_RELATION_POLICY, hidden, "registers")).toEqual({});
  });

  it("shows every available relationship without enabling ignored kinds", () => {
    const all = showAllRelations(
      SERVICE_RELATION_POLICY,
      { service: { registers: false } },
      ["registers", "calls", "references", "ipc", "renders", "mystery"],
    );
    expect(all).toEqual({ service: { calls: true, references: true, ipc: true } });
    expect(availableRelationKinds(
      SERVICE_RELATION_POLICY,
      ["registers", "calls", "references", "ipc", "renders", "mystery"],
    )).toEqual(["registers", "calls", "references", "ipc"]);
    expect(hiddenRelationKinds(
      SERVICE_RELATION_POLICY,
      all,
      ["registers", "calls", "references", "ipc", "renders", "mystery"],
    )).toEqual([]);
    expect(isRelationShown(SERVICE_RELATION_POLICY, all, "renders")).toBe(false);
  });

  it("resets one lens to policy defaults and preserves every other lens", () => {
    const overrides = {
      map: { calls: false },
      service: { calls: true, registers: false },
      ui: { references: true },
    } as const;
    const reset = resetRelationsToPolicyDefaults(SERVICE_RELATION_POLICY, overrides);
    expect(reset).toEqual({ map: { calls: false }, ui: { references: true } });
    expect(isRelationShown(SERVICE_RELATION_POLICY, reset, "calls")).toBe(false);
    expect(isRelationShown(SERVICE_RELATION_POLICY, reset, "registers")).toBe(true);
    expect(resetRelationsToPolicyDefaults(SERVICE_RELATION_POLICY, reset)).toBe(reset);
  });

  it("supports arbitrary typed policy ids", () => {
    const custom = defineLensRelationPolicy({
      id: "architecture",
      rules: [{ match: { family: "composition" }, defaultVisible: true, layoutRole: "primary", highwayWeight: 1, ghostPolicy: "boundary" }],
      fallback: FALLBACK,
    });
    const overrides: RelationVisibilityOverrides<"architecture"> = toggleRelationOverride(
      custom,
      EMPTY_RELATION_VISIBILITY_OVERRIDES,
      "owns",
    );
    expect(overrides).toEqual({ architecture: { owns: false } });
    expectTypeOf(overrides).toEqualTypeOf<RelationVisibilityOverrides<"architecture">>();
  });
});

describe("hidden kinds", () => {
  it("reports only available relations that currently render off", () => {
    expect(hiddenRelationKinds(
      SERVICE_RELATION_POLICY,
      {},
      ["registers", "calls", "references", "renders", "unknown"],
    )).toEqual(["calls", "references"]);
  });
});
