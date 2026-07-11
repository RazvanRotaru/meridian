import { describe, expect, expectTypeOf, it } from "vitest";
import { defineRelationCatalog } from "./relationCatalog";
import {
  BUILT_IN_LENS_RELATION_POLICIES,
  MAP_RELATION_POLICY,
  SERVICE_RELATION_POLICY,
  UI_RELATION_POLICY,
  defineLensRelationPolicy,
  groupRelevantRelationKinds,
  isRelationRelevant,
  isRelationVisible,
  relationGhostPolicy,
  relationHighwayWeight,
  relationParticipatesInLayout,
  relationPolicyForLens,
  relevantRelationKinds,
  resolveRelationPolicy,
} from "./lensRelationPolicy";
import type { BuiltInRelationLens } from "./lensRelationPolicy";

const FALLBACK = {
  defaultVisible: false,
  layoutRole: "ignore",
  highwayWeight: 0,
  ghostPolicy: "never",
} as const;

describe("policy resolution", () => {
  const policy = defineLensRelationPolicy({
    id: "precedence-fixture",
    rules: [
      {
        match: { family: "behavior" },
        defaultVisible: true,
        layoutRole: "primary",
        highwayWeight: 2,
        ghostPolicy: "boundary",
      },
      {
        // Deliberately after its family rule: specificity, not array order, must win.
        match: { kind: "calls" },
        defaultVisible: false,
        layoutRole: "overlay",
        highwayWeight: 7,
        ghostPolicy: "never",
      },
    ],
    fallback: FALLBACK,
  });

  it("resolves exact kind before family before fallback", () => {
    expect(resolveRelationPolicy(policy, "calls")).toMatchObject({
      matchedBy: "kind",
      family: "behavior",
      defaultVisible: false,
      layoutRole: "overlay",
      highwayWeight: 7,
    });
    expect(resolveRelationPolicy(policy, "references")).toMatchObject({
      matchedBy: "fallback",
      family: "dependency",
    });
    expect(resolveRelationPolicy(policy, "unknown-kind")).toEqual({
      kind: "unknown-kind",
      family: null,
      matchedBy: "fallback",
      ...FALLBACK,
    });
  });

  it("uses a supplied catalog to classify custom kinds", () => {
    const custom = defineRelationCatalog({
      invokes: { label: "Invokes", family: "behavior", styleToken: "call" },
    });
    expect(resolveRelationPolicy(policy, "invokes", custom)).toMatchObject({
      matchedBy: "family",
      family: "behavior",
      layoutRole: "primary",
    });
  });

  it("exposes pure visibility, layout, highway, ghost, and relevance decisions", () => {
    expect(isRelationVisible(policy, "calls")).toBe(false);
    expect(relationParticipatesInLayout(policy, "calls")).toBe(false);
    expect(relationHighwayWeight(policy, "calls")).toBe(7);
    expect(relationGhostPolicy(policy, "calls")).toBe("never");
    expect(isRelationRelevant(policy, "calls")).toBe(true);
    expect(isRelationRelevant(policy, "unknown-kind")).toBe(false);
  });
});

describe("relevant relation controls", () => {
  const policy = defineLensRelationPolicy({
    id: "controls-fixture",
    rules: [
      { match: { family: "behavior" }, defaultVisible: true, layoutRole: "primary", highwayWeight: 1, ghostPolicy: "boundary" },
      { match: { family: "dependency" }, defaultVisible: false, layoutRole: "overlay", highwayWeight: 1, ghostPolicy: "boundary" },
      { match: { kind: "custom" }, defaultVisible: false, layoutRole: "overlay", highwayWeight: 1, ghostPolicy: "never" },
    ],
    fallback: FALLBACK,
  });

  it("keeps hidden overlays filterable and drops ignored kinds", () => {
    expect(relevantRelationKinds(policy, ["calls", "references", "renders", "custom"])).toEqual([
      "calls",
      "references",
      "custom",
    ]);
  });

  it("groups known kinds by catalog family and open-vocabulary kinds separately", () => {
    expect(groupRelevantRelationKinds(policy, ["references", "custom", "calls", "imports"])).toEqual([
      { family: "behavior", kinds: ["calls"] },
      { family: "dependency", kinds: ["references", "imports"] },
      { family: null, kinds: ["custom"] },
    ]);
  });
});

describe("built-in lens policies", () => {
  it("keeps the Map's existing relationship vocabulary visible and layout-bearing", () => {
    const currentMapKinds = [
      "calls",
      "references",
      "imports",
      "extends",
      "implements",
      "instantiates",
      "sends",
      "handles",
      "ipc",
    ];
    for (const kind of currentMapKinds) {
      expect(isRelationVisible(MAP_RELATION_POLICY, kind), kind).toBe(true);
      expect(relationParticipatesInLayout(MAP_RELATION_POLICY, kind), kind).toBe(true);
      expect(relationGhostPolicy(MAP_RELATION_POLICY, kind), kind).toBe("boundary");
    }
    expect(isRelationRelevant(MAP_RELATION_POLICY, "renders")).toBe(false);
    expect(isRelationRelevant(MAP_RELATION_POLICY, "registers")).toBe(false);
  });

  it("makes Service composition primary and inheritance/construction structural", () => {
    expect(resolveRelationPolicy(SERVICE_RELATION_POLICY, "registers")).toMatchObject({
      defaultVisible: true,
      layoutRole: "primary",
      highwayWeight: 5,
    });
    for (const kind of ["extends", "implements", "instantiates"]) {
      expect(isRelationVisible(SERVICE_RELATION_POLICY, kind), kind).toBe(true);
      expect(relationParticipatesInLayout(SERVICE_RELATION_POLICY, kind), kind).toBe(true);
    }
    for (const kind of ["calls", "references", "imports"]) {
      expect(isRelationVisible(SERVICE_RELATION_POLICY, kind), kind).toBe(false);
      expect(resolveRelationPolicy(SERVICE_RELATION_POLICY, kind).layoutRole, kind).toBe("overlay");
      expect(relationParticipatesInLayout(SERVICE_RELATION_POLICY, kind), kind).toBe(false);
    }
  });

  it("lets renders drive UI while expanded-code relationships cannot displace it", () => {
    expect(resolveRelationPolicy(UI_RELATION_POLICY, "renders")).toMatchObject({
      matchedBy: "kind",
      defaultVisible: true,
      layoutRole: "primary",
    });
    expect(resolveRelationPolicy(UI_RELATION_POLICY, "implements")).toMatchObject({
      defaultVisible: true,
      layoutRole: "constraint",
    });
    for (const kind of ["calls", "instantiates", "references", "registers"]) {
      expect(isRelationVisible(UI_RELATION_POLICY, kind), kind).toBe(false);
      expect(resolveRelationPolicy(UI_RELATION_POLICY, kind).layoutRole, kind).toBe("overlay");
      expect(relationParticipatesInLayout(UI_RELATION_POLICY, kind), kind).toBe(false);
    }
  });

  it("registers the three graph policies with typed lens ids", () => {
    expect(BUILT_IN_LENS_RELATION_POLICIES).toEqual({
      map: MAP_RELATION_POLICY,
      service: SERVICE_RELATION_POLICY,
      ui: UI_RELATION_POLICY,
    });
    expect(relationPolicyForLens("service")).toBe(SERVICE_RELATION_POLICY);
    expectTypeOf<keyof typeof BUILT_IN_LENS_RELATION_POLICIES>().toEqualTypeOf<BuiltInRelationLens>();
  });
});
