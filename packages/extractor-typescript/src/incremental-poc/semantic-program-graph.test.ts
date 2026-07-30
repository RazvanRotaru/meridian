import { describe, expect, it } from "vitest";
import {
  addressSelectedSemanticProgramRegion,
  buildSemanticProgramGraph,
  planSemanticProgramGraph,
  type AddressedSemanticProgramGraph,
  type SelectedSemanticProgramRegionAddressInput,
  type SemanticProgramGraphInput,
} from "./semantic-program-graph";

describe("full-program semantic graph", () => {
  it("orders ordinary external modules explicitly and ambient libraries universally", () => {
    const graph = buildSemanticProgramGraph({
      baseContextDigest: "context-a",
      nodes: [
        node("src/selected.ts", "selected"),
        node("node_modules/pkg/index.d.ts", "package"),
        node("typescript/lib/lib.es2024.d.ts", "lib"),
      ],
      selectedNodeIds: ["src/selected.ts"],
      ambientNodeIds: ["typescript/lib/lib.es2024.d.ts"],
      dependencies: [
        edge("src/selected.ts", "node_modules/pkg/index.d.ts"),
        edge("node_modules/pkg/index.d.ts", "typescript/lib/lib.es2024.d.ts"),
      ],
    });

    const selected = componentWith(graph, "src/selected.ts");
    const packageDeclaration = componentWith(
      graph,
      "node_modules/pkg/index.d.ts",
    );
    const lib = componentWith(graph, "typescript/lib/lib.es2024.d.ts");
    const aggregate = universalProviderAggregate(graph);
    expect(graph.componentOrder.indexOf(lib.id))
      .toBeLessThan(graph.componentOrder.indexOf(packageDeclaration.id));
    expect(graph.componentOrder.indexOf(lib.id))
      .toBeLessThan(graph.componentOrder.indexOf(aggregate.id));
    expect(graph.componentOrder.indexOf(packageDeclaration.id))
      .toBeLessThan(graph.componentOrder.indexOf(selected.id));
    expect(graph.componentOrder.indexOf(aggregate.id))
      .toBeLessThan(graph.componentOrder.indexOf(selected.id));
    expect(aggregate).toMatchObject({
      kind: "universal-provider-aggregate",
      nodeIds: [],
      selectedNodeIds: [],
      externalNodeIds: [],
    });
    expect(aggregate.providerComponentIds).toEqual([lib.id]);
    expect(packageDeclaration.providerComponentIds).toEqual([lib.id]);

    const region = graph.regions[0]!;
    expect(region.files).toEqual(["src/selected.ts"]);
    expect(region.dependencyRegionIds).toEqual([]);
    expect(new Set(region.directExternalProviderComponentIds)).toEqual(
      new Set([aggregate.id, packageDeclaration.id]),
    );
    expect(new Set(region.directExternalProviderKeys)).toEqual(
      new Set([
        keyFor(graph, aggregate.id),
        keyFor(graph, packageDeclaration.id),
      ]),
    );
    expect(graph.universalProviderNodeIds).toEqual([
      "typescript/lib/lib.es2024.d.ts",
    ]);
    expect(graph.coverage).toMatchObject({
      nodeCount: 3,
      selectedNodeCount: 1,
      externalNodeCount: 2,
    });
    expect(graph.coverage.entries.map((entry) => entry.nodeId)).toEqual([
      "node_modules/pkg/index.d.ts",
      "src/selected.ts",
      "typescript/lib/lib.es2024.d.ts",
    ]);
  });

  it("forms one mixed SCC for a cycle that passes through an external source", () => {
    const graph = buildSemanticProgramGraph({
      baseContextDigest: "context-a",
      nodes: [
        node("src/selected.ts", "selected"),
        node("node_modules/pkg/index.d.ts", "external"),
      ],
      selectedNodeIds: ["src/selected.ts"],
      ambientNodeIds: [],
      dependencies: [
        edge("src/selected.ts", "node_modules/pkg/index.d.ts"),
        edge("node_modules/pkg/index.d.ts", "src/selected.ts"),
      ],
    });

    expect(graph.components).toHaveLength(1);
    const component = graph.components[0]!;
    expect(component.kind).toBe("selected");
    expect(component.nodeIds).toEqual([
      "node_modules/pkg/index.d.ts",
      "src/selected.ts",
    ]);
    expect(component.selectedNodeIds).toEqual(["src/selected.ts"]);
    expect(component.externalNodeIds).toEqual([
      "node_modules/pkg/index.d.ts",
    ]);
    expect(component.input.nodes.map((input) => input.id)).toEqual(
      component.nodeIds,
    );
    expect(component.input.containsUniversalProviderAggregate).toBe(false);
    expect(graph.coverage.entries.map((entry) => entry.nodeId)).toEqual([
      "node_modules/pkg/index.d.ts",
      "src/selected.ts",
    ]);
    expect(graph.regions).toHaveLength(1);
    expect(graph.regions[0]).toMatchObject({
      componentId: component.id,
      files: ["src/selected.ts"],
      dependencyRegionIds: [],
      directExternalProviderKeys: [],
    });
  });

  it("uses the virtual aggregate so ambient-to-selected forms one SCC", () => {
    const graph = buildSemanticProgramGraph({
      baseContextDigest: "context-a",
      nodes: [
        node("src/selected.ts", "selected"),
        node("types/globals.d.ts", "ambient"),
      ],
      selectedNodeIds: ["src/selected.ts"],
      ambientNodeIds: ["types/globals.d.ts"],
      dependencies: [
        // Explicit external consumer -> selected provider. The virtual reverse path closes it.
        edge("types/globals.d.ts", "src/selected.ts"),
      ],
    });

    expect(graph.components).toHaveLength(1);
    expect(graph.components[0]).toMatchObject({
      kind: "selected",
      selectedNodeIds: ["src/selected.ts"],
      externalNodeIds: ["types/globals.d.ts"],
      ambientNodeIds: ["types/globals.d.ts"],
      input: {
        containsUniversalProviderAggregate: true,
      },
    });
    expect(graph.regions[0]?.files).toEqual(["src/selected.ts"]);
    expect(graph.ambientExternalOnlyRootKeys).toEqual([]);
  });

  it("returns one external-only aggregate root without projecting it as a file", () => {
    const graph = buildSemanticProgramGraph({
      baseContextDigest: "context-a",
      nodes: [
        node("src/a.ts", "a"),
        node("src/b.ts", "b"),
        node("types/globals.d.ts", "ambient"),
      ],
      selectedNodeIds: ["src/a.ts", "src/b.ts"],
      ambientNodeIds: ["types/globals.d.ts"],
      dependencies: [],
    });

    const ambient = componentWith(graph, "types/globals.d.ts");
    const aggregate = universalProviderAggregate(graph);
    expect(ambient.kind).toBe("external-only");
    expect(graph.ambientExternalOnlyRootKeys).toEqual([
      keyFor(graph, aggregate.id),
    ]);
    expect(graph.regions).toHaveLength(2);
    for (const region of graph.regions) {
      expect(region.files).not.toContain("types/globals.d.ts");
      expect(region.directExternalProviderKeys).toEqual([
        keyFor(graph, aggregate.id),
      ]);
    }
  });

  it("is deterministic under node, edge, role, and object-key reordering", () => {
    const forward: SemanticProgramGraphInput = {
      baseContextDigest: "context-a",
      nodes: [
        { id: "src/a.ts", input: { blob: "a", mode: "source" } },
        { id: "src/b.ts", input: { blob: "b", mode: "source" } },
        {
          id: "node_modules/pkg/index.d.ts",
          input: { blob: "external", mode: "declaration" },
        },
        { id: "types/globals.d.ts", input: { blob: "ambient", global: true } },
      ],
      selectedNodeIds: ["src/a.ts", "src/b.ts"],
      ambientNodeIds: ["types/globals.d.ts"],
      dependencies: [
        edge("src/a.ts", "node_modules/pkg/index.d.ts"),
        edge("src/b.ts", "src/a.ts"),
        edge("node_modules/pkg/index.d.ts", "types/globals.d.ts"),
      ],
    };
    const reversed: SemanticProgramGraphInput = {
      ...forward,
      nodes: [...forward.nodes].reverse().map((entry) => ({
        id: entry.id,
        input: reverseObject(entry.input as Record<string, unknown>),
      })),
      selectedNodeIds: [...forward.selectedNodeIds].reverse(),
      ambientNodeIds: [...forward.ambientNodeIds].reverse(),
      dependencies: [...forward.dependencies].reverse(),
    };

    expect(planSemanticProgramGraph(reversed))
      .toEqual(planSemanticProgramGraph(forward));
    expect(buildSemanticProgramGraph(reversed))
      .toEqual(buildSemanticProgramGraph(forward));
  });

  it("propagates provider content changes through keys without changing unrelated keys", () => {
    const before = buildSemanticProgramGraph(providerPropagationInput("v1"));
    const after = buildSemanticProgramGraph(providerPropagationInput("v2"));

    expect(keyForNode(before, "external/provider.d.ts"))
      .not.toBe(keyForNode(after, "external/provider.d.ts"));
    expect(keyForNode(before, "external/facade.d.ts"))
      .not.toBe(keyForNode(after, "external/facade.d.ts"));
    expect(regionKeyForFile(before, "src/consumer.ts"))
      .not.toBe(regionKeyForFile(after, "src/consumer.ts"));
    expect(keyForNode(before, "external/unrelated.d.ts"))
      .toBe(keyForNode(after, "external/unrelated.d.ts"));
  });

  it("keeps an ordinary non-selected module local to its explicit consumers", () => {
    const graphInput = (externalBlob: string): SemanticProgramGraphInput => ({
      baseContextDigest: "context-a",
      nodes: [
        node("src/a.ts", "a"),
        node("src/b.ts", "b"),
        node("external/provider.d.ts", externalBlob),
        node("external/unchanged.d.ts", "unchanged"),
      ],
      selectedNodeIds: ["src/a.ts", "src/b.ts"],
      ambientNodeIds: [],
      dependencies: [edge("src/a.ts", "external/provider.d.ts")],
    });
    const before = buildSemanticProgramGraph(graphInput("v1"));
    const after = buildSemanticProgramGraph(graphInput("v2"));

    expect(before.universalProviderNodeIds).toEqual([]);
    expect(keyForNode(before, "external/provider.d.ts"))
      .not.toBe(keyForNode(after, "external/provider.d.ts"));
    expect(keyForNode(before, "external/unchanged.d.ts"))
      .toBe(keyForNode(after, "external/unchanged.d.ts"));
    expect(regionKeyForFile(before, "src/a.ts"))
      .not.toBe(regionKeyForFile(after, "src/a.ts"));
    expect(regionKeyForFile(before, "src/b.ts"))
      .toBe(regionKeyForFile(after, "src/b.ts"));
  });

  it("makes a proven non-selected ambient source invalidate every selected region", () => {
    const graphInput = (ambientBlob: string): SemanticProgramGraphInput => ({
      baseContextDigest: "context-a",
      nodes: [
        node("src/a.ts", "a"),
        node("src/b.ts", "b"),
        node("types/globals.d.ts", ambientBlob),
        node("external/module.d.ts", "ordinary-module"),
      ],
      selectedNodeIds: ["src/a.ts", "src/b.ts"],
      ambientNodeIds: ["types/globals.d.ts"],
      dependencies: [],
    });
    const before = buildSemanticProgramGraph(graphInput("v1"));
    const after = buildSemanticProgramGraph(graphInput("v2"));

    expect(before.universalProviderNodeIds).toEqual(["types/globals.d.ts"]);
    expect(keyForNode(before, "external/module.d.ts"))
      .toBe(keyForNode(after, "external/module.d.ts"));
    for (const selectedFile of ["src/a.ts", "src/b.ts"]) {
      expect(regionKeyForFile(before, selectedFile))
        .not.toBe(regionKeyForFile(after, selectedFile));
    }
  });

  it("lets the caller add selected inputs while preserving exact provider keys", () => {
    const seen: SelectedSemanticProgramRegionAddressInput[] = [];
    const graph = buildSemanticProgramGraph(
      {
        baseContextDigest: "context-a",
        nodes: [
          node("src/provider.ts", "provider"),
          node("src/consumer.ts", "consumer"),
          node("external/types.d.ts", "external"),
        ],
        selectedNodeIds: ["src/provider.ts", "src/consumer.ts"],
        ambientNodeIds: [],
        dependencies: [
          edge("src/consumer.ts", "src/provider.ts"),
          edge("src/consumer.ts", "external/types.d.ts"),
        ],
      },
      (input) => {
        seen.push(input);
        return addressSelectedSemanticProgramRegion(input, {
          extractorRegionSchema: 7,
        });
      },
    );

    const consumerRegion = graph.regions.find((region) =>
      region.files.includes("src/consumer.ts"));
    const consumerInput = seen.find((input) =>
      input.files.includes("src/consumer.ts"));
    expect(consumerInput).toBeDefined();
    expect(consumerInput!.selectedProviderRegionKeys).toEqual([
      {
        regionId: consumerRegion!.dependencyRegionIds[0],
        key: regionKeyForFile(graph, "src/provider.ts"),
      },
    ]);
    expect(consumerInput!.directExternalProviderKeys).toEqual([
      keyForNode(graph, "external/types.d.ts"),
    ]);
    expect(consumerRegion!.key).toBe(
      addressSelectedSemanticProgramRegion(consumerInput!, {
        extractorRegionSchema: 7,
      }),
    );
  });

  it("owns an external input once even when several selected regions consume it", () => {
    const uniquePayload = "EXTERNAL_UNIQUE_PAYLOAD";
    const plan = planSemanticProgramGraph({
      baseContextDigest: "context-a",
      nodes: [
        node("src/a.ts", "a"),
        node("src/b.ts", "b"),
        node("external/shared.d.ts", uniquePayload),
      ],
      selectedNodeIds: ["src/a.ts", "src/b.ts"],
      ambientNodeIds: [],
      dependencies: [
        edge("src/a.ts", "external/shared.d.ts"),
        edge("src/b.ts", "external/shared.d.ts"),
      ],
    });

    expect(plan.components.filter((component) =>
      component.externalNodeIds.includes("external/shared.d.ts"))).toHaveLength(1);
    expect(plan.regions.every((region) =>
      !region.files.includes("external/shared.d.ts"))).toBe(true);
    expect(JSON.stringify(plan).split(uniquePayload)).toHaveLength(2);
  });

  it("fails closed for unknown endpoints and duplicate identities", () => {
    expect(() => planSemanticProgramGraph({
      baseContextDigest: "context-a",
      nodes: [node("src/a.ts", "a")],
      selectedNodeIds: ["src/a.ts"],
      ambientNodeIds: [],
      dependencies: [edge("src/a.ts", "missing.d.ts")],
    })).toThrow("dependency endpoint is outside the exact program");

    expect(() => planSemanticProgramGraph({
      baseContextDigest: "context-a",
      nodes: [node("src/a.ts", "first"), node("src/a.ts", "second")],
      selectedNodeIds: ["src/a.ts"],
      ambientNodeIds: [],
      dependencies: [],
    })).toThrow("duplicate semantic program node id");

    expect(() => planSemanticProgramGraph({
      baseContextDigest: "context-a",
      nodes: [node("src/a.ts", "a")],
      selectedNodeIds: ["src/a.ts", "src/a.ts"],
      ambientNodeIds: [],
      dependencies: [],
    })).toThrow("duplicate selected semantic program node id");

    expect(() => planSemanticProgramGraph({
      baseContextDigest: "context-a",
      nodes: [node("src/a.ts", "a")],
      selectedNodeIds: ["src/a.ts"],
      ambientNodeIds: ["missing.d.ts"],
      dependencies: [],
    })).toThrow("ambient semantic program node is outside the exact program");
  });

  it("addresses thousands of selected and ambient sources with linear aggregate fanout", () => {
    const selectedIds = Array.from(
      { length: 2_000 },
      (_, index) => `src/selected-${String(index).padStart(4, "0")}.ts`,
    );
    const externalIds = Array.from(
      { length: 2_000 },
      (_, index) => `external/provider-${String(index).padStart(4, "0")}.d.ts`,
    );
    const graph = buildSemanticProgramGraph({
      baseContextDigest: "context-a",
      nodes: [...selectedIds, ...externalIds].map((id) => node(id, id)),
      selectedNodeIds: selectedIds,
      ambientNodeIds: externalIds,
      dependencies: [],
    });

    const aggregate = universalProviderAggregate(graph);
    expect(graph.coverage).toMatchObject({
      nodeCount: selectedIds.length + externalIds.length,
      selectedNodeCount: selectedIds.length,
      externalNodeCount: externalIds.length,
    });
    expect(graph.coverage.entries).toHaveLength(
      selectedIds.length + externalIds.length,
    );
    expect(graph.components).toHaveLength(
      selectedIds.length + externalIds.length + 1,
    );
    expect(aggregate.providerComponentIds).toHaveLength(externalIds.length);
    const selectedComponents = graph.components.filter(
      (component) => component.kind === "selected",
    );
    expect(selectedComponents).toHaveLength(selectedIds.length);
    expect(selectedComponents.every(
      (component) => (
        component.providerComponentIds.length === 1
        && component.providerComponentIds[0] === aggregate.id
      ),
    )).toBe(true);
    expect(graph.regions.every(
      (region) => (
        region.directExternalProviderComponentIds.length === 1
        && region.directExternalProviderComponentIds[0] === aggregate.id
      ),
    )).toBe(true);
  });

  it("walks a large full-program chain iteratively", () => {
    const ids = Array.from(
      { length: 5_000 },
      (_, index) => `program/source-${String(index).padStart(4, "0")}.ts`,
    );
    const plan = planSemanticProgramGraph({
      baseContextDigest: "context-a",
      nodes: ids.map((id) => node(id, id)),
      selectedNodeIds: [ids.at(-1)!],
      ambientNodeIds: [],
      dependencies: ids.slice(1).map((consumer, index) =>
        edge(consumer, ids[index]!)),
    });

    expect(plan.components).toHaveLength(ids.length);
    expect(plan.componentOrder).toHaveLength(ids.length);
    expect(plan.coverage.entries).toHaveLength(ids.length);
    expect(plan.coverage.entries.every((entry) => !entry.nodeId.includes("\0")))
      .toBe(true);
    expect(plan.componentOrder[0]).toBe(componentWith(plan, ids[0]!).id);
    expect(plan.componentOrder.at(-1)).toBe(componentWith(plan, ids.at(-1)!).id);
  });
});

function node(id: string, blob: string) {
  return { id, input: { blob } };
}

function edge(consumer: string, provider: string) {
  return { consumer, provider };
}

function componentWith(
  graph: Pick<AddressedSemanticProgramGraph, "components">,
  nodeId: string,
) {
  const component = graph.components.find((candidate) =>
    candidate.nodeIds.includes(nodeId));
  if (component === undefined) throw new Error(`missing component for ${nodeId}`);
  return component;
}

function universalProviderAggregate(
  graph: Pick<AddressedSemanticProgramGraph, "components">,
) {
  const component = graph.components.find(
    (candidate) => candidate.input.containsUniversalProviderAggregate,
  );
  if (component === undefined) {
    throw new Error("missing universal-provider aggregate component");
  }
  return component;
}

function keyFor(graph: AddressedSemanticProgramGraph, componentId: string) {
  const entry = graph.componentKeys.find((candidate) =>
    candidate.componentId === componentId);
  if (entry === undefined) throw new Error(`missing key for ${componentId}`);
  return entry.key;
}

function keyForNode(graph: AddressedSemanticProgramGraph, nodeId: string) {
  return keyFor(graph, componentWith(graph, nodeId).id);
}

function regionKeyForFile(
  graph: AddressedSemanticProgramGraph,
  file: string,
) {
  const region = graph.regions.find((candidate) =>
    candidate.files.includes(file));
  if (region === undefined) throw new Error(`missing region for ${file}`);
  return region.key;
}

function reverseObject(
  value: Record<string, unknown>,
): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).reverse());
}

function providerPropagationInput(providerBlob: string): SemanticProgramGraphInput {
  return {
    baseContextDigest: "context-a",
    nodes: [
      node("src/consumer.ts", "consumer"),
      node("external/facade.d.ts", "facade"),
      node("external/provider.d.ts", providerBlob),
      node("external/unrelated.d.ts", "unrelated"),
    ],
    selectedNodeIds: ["src/consumer.ts"],
    ambientNodeIds: [],
    dependencies: [
      edge("src/consumer.ts", "external/facade.d.ts"),
      edge("external/facade.d.ts", "external/provider.d.ts"),
    ],
  };
}
