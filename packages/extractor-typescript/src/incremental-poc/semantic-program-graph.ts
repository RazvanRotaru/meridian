/**
 * Pure full-program dependency planning for semantic-region cache keys.
 *
 * The graph contains every source visible to one exact TypeScript Program, not only the sources
 * selected for extraction. Edges point from a consumer to a provider. SCCs are consequently the
 * smallest units that can be addressed independently without losing cycles through non-selected
 * declarations.
 *
 * Non-selected inputs are owned by exactly one component and influence selected sources through
 * explicit compiler-observed dependency edges. Only sources proven ambient (scripts/global or
 * module augmentations, UMD global exports, and default libraries) influence every selected
 * source through one internal universal-provider aggregate. A selected component is projected to
 * a semantic region containing selected files only; when an SCC is mixed, the projected region
 * owns the component's non-selected inputs through `component.input`.
 * External-only components and the aggregate are Merkle-addressed from their own input and direct
 * provider component keys. Selected components are addressed by a caller callback in the same
 * provider-before-consumer traversal, allowing an existing region key schema to add
 * extractor-specific inputs without flattening transitive program inputs into every region.
 */

import {
  canonicalJson,
  canonicalJsonSha256,
  compareCanonicalStrings,
} from "./canonical-json";

export const SEMANTIC_PROGRAM_GRAPH_VERSION = 3 as const;

/**
 * Caller ids reject NUL, so this internal-only vertex cannot collide with a program source. It is
 * deliberately filtered from components' node lists and exact caller coverage.
 */
const UNIVERSAL_PROVIDER_AGGREGATE_NODE_ID =
  "\0semantic-program-universal-provider-aggregate";

export interface SemanticProgramNode {
  /** Caller-canonical source identity. No path normalization is performed here. */
  id: string;
  /** Complete immutable fingerprint input for this exact source. */
  input: unknown;
}

export interface SemanticProgramDependency {
  /** Source whose semantic output may change. */
  consumer: string;
  /** Source whose semantics may influence the consumer. */
  provider: string;
}

export interface SemanticProgramGraphInput {
  /** Exact non-source context shared by every component key. */
  baseContextDigest: string;
  /** Every source in the TypeScript Program: selected and non-selected. */
  nodes: readonly SemanticProgramNode[];
  /** Exact sources selected for graph extraction. */
  selectedNodeIds: readonly string[];
  /**
   * Detected script/global/augmentation/UMD/default-library sources whose declarations may affect
   * every selected source. Ordinary non-selected external modules are intentionally not included:
   * their influence is represented by the complete explicit dependency graph supplied above.
   */
  ambientNodeIds: readonly string[];
  /** Complete observed semantic dependencies. Edges are consumer -> provider. */
  dependencies: readonly SemanticProgramDependency[];
}

export interface SemanticProgramCanonicalNodeInput {
  id: string;
  /**
   * Canonical JSON is retained instead of the caller's mutable object. Each source input is
   * serialized once and then owned by exactly one component.
   */
  canonicalInput: string;
}

export interface SemanticProgramComponentInput {
  /** Selected and ambient roles are semantic inputs to the virtual aggregate rule. */
  selectedNodeIds: string[];
  ambientNodeIds: string[];
  /** True when this SCC owns the internal universal-provider aggregate vertex. */
  containsUniversalProviderAggregate: boolean;
  nodes: SemanticProgramCanonicalNodeInput[];
  /**
   * Explicit outgoing dependencies whose consumer belongs to this component. This makes changes
   * to dependency endpoints part of the consumer component's address. Virtual aggregate edges
   * are represented by the versioned planner rule, roles, and aggregate flag instead of being
   * repeated here.
   */
  dependencies: SemanticProgramDependency[];
}

export interface SemanticProgramComponent {
  id: string;
  kind: "selected" | "external-only" | "universal-provider-aggregate";
  nodeIds: string[];
  selectedNodeIds: string[];
  externalNodeIds: string[];
  ambientNodeIds: string[];
  input: SemanticProgramComponentInput;
  /** Direct providers in the SCC condensation graph. */
  providerComponentIds: string[];
}

export interface ProjectedSemanticProgramRegion {
  id: string;
  componentId: string;
  /** Only selected program sources appear in the projected region. */
  files: string[];
  /** Direct provider components that also project to selected regions. */
  dependencyRegionIds: string[];
  /** Direct provider components that contain no selected sources. */
  directExternalProviderComponentIds: string[];
}

export interface SemanticProgramCoverageEntry {
  nodeId: string;
  selected: boolean;
  ambient: boolean;
  componentId: string;
  projectedRegionId: string | null;
}

export interface SemanticProgramCoverage {
  nodeCount: number;
  selectedNodeCount: number;
  externalNodeCount: number;
  entries: SemanticProgramCoverageEntry[];
}

export interface SemanticProgramGraphPlan {
  version: typeof SEMANTIC_PROGRAM_GRAPH_VERSION;
  baseContextDigest: string;
  /** Caller nodes connected through the internal universal-provider aggregate. */
  universalProviderNodeIds: string[];
  ambientNodeIds: string[];
  components: SemanticProgramComponent[];
  /** Direct providers precede their consumers. */
  componentOrder: string[];
  regions: ProjectedSemanticProgramRegion[];
  coverage: SemanticProgramCoverage;
}

export interface SemanticProgramProviderKey {
  componentId: string;
  key: string;
}

export interface SemanticProgramRegionProviderKey {
  regionId: string;
  key: string;
}

export interface SelectedSemanticProgramRegionAddressInput {
  version: typeof SEMANTIC_PROGRAM_GRAPH_VERSION;
  baseContextDigest: string;
  componentId: string;
  regionId: string;
  files: string[];
  componentInput: SemanticProgramComponentInput;
  /** Keys for every direct provider component, ordered by canonical component id. */
  providerComponentKeys: SemanticProgramProviderKey[];
  selectedProviderRegionKeys: SemanticProgramRegionProviderKey[];
  directExternalProviderKeys: string[];
}

export type AddressSelectedSemanticProgramRegion = (
  input: SelectedSemanticProgramRegionAddressInput,
) => string;

export interface AddressedProjectedSemanticProgramRegion
  extends ProjectedSemanticProgramRegion {
  key: string;
  directExternalProviderKeys: string[];
}

export interface AddressedSemanticProgramGraph
  extends Omit<SemanticProgramGraphPlan, "regions"> {
  componentKeys: SemanticProgramProviderKey[];
  regions: AddressedProjectedSemanticProgramRegion[];
  /** At most one key: the aggregate when its SCC contains no selected source. */
  ambientExternalOnlyRootKeys: string[];
}

/**
 * Build the one full-program SCC graph. No ts-morph or TypeScript object escapes into this model.
 */
export function planSemanticProgramGraph(
  input: SemanticProgramGraphInput,
): SemanticProgramGraphPlan {
  const baseContextDigest = canonicalIdentity(
    input.baseContextDigest,
    "semantic program base context digest",
  );
  const nodes = canonicalNodes(input.nodes);
  const nodeIds = nodes.map((node) => node.id);
  const nodeIdSet = new Set(nodeIds);
  const selectedNodeIds = canonicalIdList(
    input.selectedNodeIds,
    "selected semantic program node",
  );
  const ambientNodeIds = canonicalIdList(
    input.ambientNodeIds,
    "ambient semantic program node",
  );
  requireKnownIds(selectedNodeIds, nodeIdSet, "selected semantic program node");
  requireKnownIds(ambientNodeIds, nodeIdSet, "ambient semantic program node");

  const selected = new Set(selectedNodeIds);
  const ambient = new Set(ambientNodeIds);
  const universalProviderNodeIds = [...ambientNodeIds];
  const dependencies = canonicalDependencies(input.dependencies, nodeIdSet);
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  const dependenciesByConsumer = groupDependenciesByConsumer(dependencies);
  const topology = dependencyTopology(
    nodeIds,
    dependencies,
    selectedNodeIds,
    universalProviderNodeIds,
  );
  const componentMembers = stronglyConnectedComponents(
    topology.nodeIds,
    topology.adjacency,
  )
    .map((members) => members.sort(compareCanonicalStrings))
    .sort(compareStringArrays);

  const componentByNode = new Map<string, SemanticProgramComponent>();
  const components = componentMembers.map((members) => {
    const callerMembers = members.filter(
      (nodeId) => nodeId !== UNIVERSAL_PROVIDER_AGGREGATE_NODE_ID,
    );
    const selectedMembers = callerMembers.filter((nodeId) => selected.has(nodeId));
    const component = makeComponent({
      members,
      selectedMembers,
      ambient,
      nodeById,
      dependenciesByConsumer,
    });
    for (const nodeId of members) componentByNode.set(nodeId, component);
    return component;
  }).sort((left, right) => compareCanonicalStrings(left.id, right.id));
  requireUniqueGeneratedIds(components.map((component) => component.id), "component");

  const providersByComponent = new Map(
    components.map((component) => [component.id, new Set<string>()]),
  );
  for (const [consumer, providers] of topology.adjacency) {
    const consumerComponent = requireComponent(componentByNode, consumer);
    for (const provider of providers) {
      const providerComponent = requireComponent(componentByNode, provider);
      if (consumerComponent.id !== providerComponent.id) {
        providersByComponent.get(consumerComponent.id)!.add(providerComponent.id);
      }
    }
  }
  for (const component of components) {
    component.providerComponentIds = [
      ...providersByComponent.get(component.id)!,
    ].sort(compareCanonicalStrings);
  }

  const regionByComponent = new Map<string, ProjectedSemanticProgramRegion>();
  for (const component of components) {
    if (component.selectedNodeIds.length === 0) continue;
    const region: ProjectedSemanticProgramRegion = {
      id: semanticProgramRegionId(component.selectedNodeIds),
      componentId: component.id,
      files: [...component.selectedNodeIds],
      dependencyRegionIds: [],
      directExternalProviderComponentIds: [],
    };
    regionByComponent.set(component.id, region);
  }
  requireUniqueGeneratedIds(
    [...regionByComponent.values()].map((region) => region.id),
    "projected region",
  );

  for (const component of components) {
    const region = regionByComponent.get(component.id);
    if (region === undefined) continue;
    for (const providerId of component.providerComponentIds) {
      const providerRegion = regionByComponent.get(providerId);
      if (providerRegion === undefined) {
        region.directExternalProviderComponentIds.push(providerId);
      } else {
        region.dependencyRegionIds.push(providerRegion.id);
      }
    }
    region.dependencyRegionIds.sort(compareCanonicalStrings);
    region.directExternalProviderComponentIds.sort(compareCanonicalStrings);
  }

  const componentOrder = providerFirstComponentOrder(components);
  const regions = [...regionByComponent.values()]
    .sort((left, right) => compareCanonicalStrings(left.id, right.id));
  const coverage = exactCoverage(
    nodes,
    selected,
    ambient,
    componentByNode,
    regionByComponent,
  );

  return {
    version: SEMANTIC_PROGRAM_GRAPH_VERSION,
    baseContextDigest,
    universalProviderNodeIds,
    ambientNodeIds,
    components,
    componentOrder,
    regions,
    coverage,
  };
}

/**
 * Address every component in provider-before-consumer order.
 *
 * External-only components use the module's fixed Merkle schema. The callback addresses selected
 * regions from the same exact component input and provider keys; it may call
 * `addressSelectedSemanticProgramRegion` to use the default schema with additional caller input.
 */
export function addressSemanticProgramGraph(
  plan: SemanticProgramGraphPlan,
  addressSelected: AddressSelectedSemanticProgramRegion = (input) =>
    addressSelectedSemanticProgramRegion(input),
): AddressedSemanticProgramGraph {
  validatePlanShape(plan);
  const componentById = new Map(
    plan.components.map((component) => [component.id, component]),
  );
  const regionByComponent = new Map(
    plan.regions.map((region) => [region.componentId, region]),
  );
  const componentKeyById = new Map<string, string>();
  const addressedRegionById = new Map<
    string,
    AddressedProjectedSemanticProgramRegion
  >();

  for (const componentId of plan.componentOrder) {
    const component = requireKnownComponentId(componentById, componentId);
    const providerComponentKeys = component.providerComponentIds.map(
      (providerId): SemanticProgramProviderKey => ({
        componentId: providerId,
        key: requireAddressedKey(componentKeyById, providerId),
      }),
    );
    const region = regionByComponent.get(componentId);
    let key: string;
    if (region === undefined) {
      key = externalComponentKey(
        plan.baseContextDigest,
        component,
        providerComponentKeys,
      );
    } else {
      const selectedProviderRegionKeys = component.providerComponentIds
        .map((providerId) => regionByComponent.get(providerId))
        .filter(
          (providerRegion): providerRegion is ProjectedSemanticProgramRegion =>
            providerRegion !== undefined,
        )
        .map((providerRegion): SemanticProgramRegionProviderKey => ({
          regionId: providerRegion.id,
          key: requireAddressedKey(
            componentKeyById,
            providerRegion.componentId,
          ),
        }))
        .sort((left, right) => compareCanonicalStrings(left.regionId, right.regionId));
      const directExternalProviderKeys = region
        .directExternalProviderComponentIds
        .map((providerId) => requireAddressedKey(componentKeyById, providerId));
      key = addressSelected({
        version: SEMANTIC_PROGRAM_GRAPH_VERSION,
        baseContextDigest: plan.baseContextDigest,
        componentId: component.id,
        regionId: region.id,
        files: [...region.files],
        componentInput: component.input,
        providerComponentKeys,
        selectedProviderRegionKeys,
        directExternalProviderKeys,
      });
      requireAddress(key, `selected semantic program region ${region.id}`);
      addressedRegionById.set(region.id, {
        ...region,
        key,
        directExternalProviderKeys,
      });
    }
    componentKeyById.set(componentId, key);
  }

  const aggregateComponents = plan.components.filter(
    (component) => component.input.containsUniversalProviderAggregate,
  );
  if (aggregateComponents.length > 1) {
    throw new TypeError(
      "semantic program plan contains more than one universal-provider aggregate",
    );
  }
  const aggregateComponent = aggregateComponents[0];
  const ambientExternalOnlyRootKeys = (
    aggregateComponent !== undefined
    && !regionByComponent.has(aggregateComponent.id)
  )
    ? [requireAddressedKey(componentKeyById, aggregateComponent.id)]
    : [];

  return {
    version: plan.version,
    baseContextDigest: plan.baseContextDigest,
    universalProviderNodeIds: [...plan.universalProviderNodeIds],
    ambientNodeIds: [...plan.ambientNodeIds],
    components: plan.components,
    componentOrder: [...plan.componentOrder],
    coverage: plan.coverage,
    componentKeys: plan.componentOrder.map((componentId) => ({
      componentId,
      key: requireAddressedKey(componentKeyById, componentId),
    })),
    regions: plan.regions.map((region) => {
      const addressed = addressedRegionById.get(region.id);
      if (addressed === undefined) {
        throw new Error(`semantic program region was not addressed: ${region.id}`);
      }
      return addressed;
    }),
    ambientExternalOnlyRootKeys,
  };
}

/** Convenience for callers that want planning and addressing as one pure operation. */
export function buildSemanticProgramGraph(
  input: SemanticProgramGraphInput,
  addressSelected?: AddressSelectedSemanticProgramRegion,
): AddressedSemanticProgramGraph {
  return addressSemanticProgramGraph(
    planSemanticProgramGraph(input),
    addressSelected,
  );
}

/**
 * Default selected-region content address. `callerInput` is where an extractor can add its
 * region-local schema/provenance inputs while preserving the full-program component dependencies.
 */
export function addressSelectedSemanticProgramRegion(
  input: SelectedSemanticProgramRegionAddressInput,
  callerInput: unknown = null,
): string {
  return `semantic-program-region-v${SEMANTIC_PROGRAM_GRAPH_VERSION}:${
    canonicalJsonSha256({
      version: SEMANTIC_PROGRAM_GRAPH_VERSION,
      kind: "selected-region",
      baseContextDigest: input.baseContextDigest,
      componentId: input.componentId,
      regionId: input.regionId,
      files: input.files,
      componentInput: input.componentInput,
      providerComponentKeys: input.providerComponentKeys,
      callerInput,
    })
  }`;
}

function canonicalNodes(
  nodes: readonly SemanticProgramNode[],
): SemanticProgramCanonicalNodeInput[] {
  const byId = new Map<string, SemanticProgramCanonicalNodeInput>();
  for (const node of nodes) {
    const id = canonicalIdentity(node.id, "semantic program node id");
    if (byId.has(id)) {
      throw new TypeError(`duplicate semantic program node id: ${id}`);
    }
    let canonicalInput: string;
    try {
      canonicalInput = canonicalJson(node.input);
    } catch (error) {
      throw new TypeError(
        `invalid semantic program input for ${id}: ${errorMessage(error)}`,
      );
    }
    byId.set(id, { id, canonicalInput });
  }
  return [...byId.values()].sort((left, right) =>
    compareCanonicalStrings(left.id, right.id));
}

function canonicalIdList(
  ids: readonly string[],
  label: string,
): string[] {
  const result = ids.map((id) => canonicalIdentity(id, `${label} id`))
    .sort(compareCanonicalStrings);
  for (let index = 1; index < result.length; index += 1) {
    if (result[index - 1] === result[index]) {
      throw new TypeError(`duplicate ${label} id: ${result[index]}`);
    }
  }
  return result;
}

function canonicalIdentity(value: string, label: string): string {
  if (typeof value !== "string" || value.length === 0 || value.includes("\0")) {
    throw new TypeError(`${label} must be a non-empty NUL-free string`);
  }
  return value;
}

function requireKnownIds(
  ids: readonly string[],
  known: ReadonlySet<string>,
  label: string,
): void {
  for (const id of ids) {
    if (!known.has(id)) {
      throw new TypeError(`${label} is outside the exact program: ${id}`);
    }
  }
}

function canonicalDependencies(
  dependencies: readonly SemanticProgramDependency[],
  knownNodeIds: ReadonlySet<string>,
): SemanticProgramDependency[] {
  const byIdentity = new Map<string, SemanticProgramDependency>();
  for (const dependency of dependencies) {
    const consumer = canonicalIdentity(
      dependency.consumer,
      "semantic program dependency consumer",
    );
    const provider = canonicalIdentity(
      dependency.provider,
      "semantic program dependency provider",
    );
    if (!knownNodeIds.has(consumer) || !knownNodeIds.has(provider)) {
      throw new TypeError(
        "semantic program dependency endpoint is outside the exact program: "
        + `${consumer} -> ${provider}`,
      );
    }
    byIdentity.set(edgeIdentity(consumer, provider), { consumer, provider });
  }
  return [...byIdentity.values()].sort(compareDependencies);
}

interface SemanticProgramDependencyTopology {
  nodeIds: string[];
  adjacency: ReadonlyMap<string, readonly string[]>;
}

/**
 * Replace the complete selected x universal-provider relation with one internal vertex:
 *
 *   selected -> aggregate -> universal provider
 *
 * This preserves reachability and therefore SCC cycles while requiring only O(S + U) artificial
 * edges. Explicit selected -> universal-provider edges are redundant paths through the aggregate;
 * they remain in the owning component input but are omitted from topology to avoid duplicate
 * provider fanout.
 */
function dependencyTopology(
  nodeIds: readonly string[],
  dependencies: readonly SemanticProgramDependency[],
  selectedNodeIds: readonly string[],
  universalProviderNodeIds: readonly string[],
): SemanticProgramDependencyTopology {
  const hasAggregate = (
    selectedNodeIds.length > 0
    && universalProviderNodeIds.length > 0
  );
  const topologyNodeIds = hasAggregate
    ? [...nodeIds, UNIVERSAL_PROVIDER_AGGREGATE_NODE_ID]
      .sort(compareCanonicalStrings)
    : [...nodeIds];
  const adjacency = new Map(
    topologyNodeIds.map((nodeId) => [nodeId, new Set<string>()]),
  );
  const selected = new Set(selectedNodeIds);
  const universalProviders = new Set(universalProviderNodeIds);
  for (const dependency of dependencies) {
    if (
      hasAggregate
      && selected.has(dependency.consumer)
      && universalProviders.has(dependency.provider)
    ) {
      continue;
    }
    adjacency.get(dependency.consumer)!.add(dependency.provider);
  }
  if (hasAggregate) {
    const aggregateProviders = adjacency.get(
      UNIVERSAL_PROVIDER_AGGREGATE_NODE_ID,
    )!;
    for (const providerNodeId of universalProviderNodeIds) {
      aggregateProviders.add(providerNodeId);
    }
    for (const selectedNodeId of selectedNodeIds) {
      adjacency.get(selectedNodeId)!.add(
        UNIVERSAL_PROVIDER_AGGREGATE_NODE_ID,
      );
    }
  }
  return {
    nodeIds: topologyNodeIds,
    adjacency: new Map([...adjacency].map(([nodeId, providers]) => [
      nodeId,
      [...providers].sort(compareCanonicalStrings),
    ])),
  };
}

/** Iterative Kosaraju avoids a JavaScript call-stack bound on large compiler programs. */
function stronglyConnectedComponents(
  nodeIds: readonly string[],
  adjacency: ReadonlyMap<string, readonly string[]>,
): string[][] {
  const visited = new Set<string>();
  const finishOrder: string[] = [];
  for (const nodeId of nodeIds) {
    if (visited.has(nodeId)) continue;
    visited.add(nodeId);
    const stack: Array<{ nodeId: string; next: number }> = [
      { nodeId, next: 0 },
    ];
    while (stack.length > 0) {
      const frame = stack.at(-1)!;
      const providers = adjacency.get(frame.nodeId);
      if (providers === undefined) {
        throw new Error(`semantic program adjacency is missing node: ${frame.nodeId}`);
      }
      const provider = providers[frame.next];
      if (provider !== undefined) {
        frame.next += 1;
        if (!visited.has(provider)) {
          visited.add(provider);
          stack.push({ nodeId: provider, next: 0 });
        }
      } else {
        finishOrder.push(frame.nodeId);
        stack.pop();
      }
    }
  }

  const reverse = new Map(nodeIds.map((nodeId) => [nodeId, [] as string[]]));
  for (const [consumer, providers] of adjacency) {
    for (const provider of providers) reverse.get(provider)!.push(consumer);
  }
  reverse.forEach((consumers) => consumers.sort(compareCanonicalStrings));

  const assigned = new Set<string>();
  const components: string[][] = [];
  for (let index = finishOrder.length - 1; index >= 0; index -= 1) {
    const root = finishOrder[index]!;
    if (assigned.has(root)) continue;
    assigned.add(root);
    const members: string[] = [];
    const pending = [root];
    while (pending.length > 0) {
      const nodeId = pending.pop()!;
      members.push(nodeId);
      for (const consumer of reverse.get(nodeId) ?? []) {
        if (!assigned.has(consumer)) {
          assigned.add(consumer);
          pending.push(consumer);
        }
      }
    }
    components.push(members);
  }
  return components;
}

function makeComponent(input: {
  members: readonly string[];
  selectedMembers: readonly string[];
  ambient: ReadonlySet<string>;
  nodeById: ReadonlyMap<string, SemanticProgramCanonicalNodeInput>;
  dependenciesByConsumer: ReadonlyMap<
    string,
    readonly SemanticProgramDependency[]
  >;
}): SemanticProgramComponent {
  const containsUniversalProviderAggregate = input.members.includes(
    UNIVERSAL_PROVIDER_AGGREGATE_NODE_ID,
  );
  const callerMembers = input.members.filter(
    (nodeId) => nodeId !== UNIVERSAL_PROVIDER_AGGREGATE_NODE_ID,
  );
  const selectedSet = new Set(input.selectedMembers);
  const nodeIds = [...callerMembers];
  const selectedNodeIds = [...input.selectedMembers];
  const externalNodeIds = nodeIds.filter((nodeId) => !selectedSet.has(nodeId));
  const ambientNodeIds = nodeIds.filter((nodeId) => input.ambient.has(nodeId));
  const componentInput: SemanticProgramComponentInput = {
    selectedNodeIds,
    ambientNodeIds,
    containsUniversalProviderAggregate,
    nodes: nodeIds.map((nodeId) => {
      const node = input.nodeById.get(nodeId);
      if (node === undefined) {
        throw new Error(`semantic program component is missing input: ${nodeId}`);
      }
      return node;
    }),
    dependencies: nodeIds.flatMap(
      (nodeId) => input.dependenciesByConsumer.get(nodeId) ?? [],
    ),
  };
  const kind = selectedNodeIds.length > 0
    ? "selected"
    : containsUniversalProviderAggregate
      ? "universal-provider-aggregate"
      : "external-only";
  return {
    id: `semantic-program-component-v${SEMANTIC_PROGRAM_GRAPH_VERSION}:${
      canonicalJsonSha256({
        nodeIds,
        selectedNodeIds,
        containsUniversalProviderAggregate,
      })
    }`,
    kind,
    nodeIds,
    selectedNodeIds,
    externalNodeIds,
    ambientNodeIds,
    input: componentInput,
    providerComponentIds: [],
  };
}

function groupDependenciesByConsumer(
  dependencies: readonly SemanticProgramDependency[],
): ReadonlyMap<string, readonly SemanticProgramDependency[]> {
  const result = new Map<string, SemanticProgramDependency[]>();
  for (const dependency of dependencies) {
    const entries = result.get(dependency.consumer);
    if (entries === undefined) result.set(dependency.consumer, [dependency]);
    else entries.push(dependency);
  }
  return result;
}

function providerFirstComponentOrder(
  components: readonly SemanticProgramComponent[],
): string[] {
  const componentById = new Map(
    components.map((component) => [component.id, component]),
  );
  const remainingProviders = new Map(
    components.map((component) => [
      component.id,
      component.providerComponentIds.length,
    ]),
  );
  const consumersByProvider = new Map(
    components.map((component) => [component.id, [] as string[]]),
  );
  for (const component of components) {
    for (const providerId of component.providerComponentIds) {
      if (!componentById.has(providerId)) {
        throw new Error(
          `semantic program component depends on unknown provider: ${providerId}`,
        );
      }
      consumersByProvider.get(providerId)!.push(component.id);
    }
  }
  consumersByProvider.forEach((consumers) =>
    consumers.sort(compareCanonicalStrings));

  const ready: string[] = [];
  for (const [componentId, count] of remainingProviders) {
    if (count === 0) pushCanonicalMinHeap(ready, componentId);
  }
  const order: string[] = [];
  while (ready.length > 0) {
    const providerId = popCanonicalMinHeap(ready)!;
    order.push(providerId);
    for (const consumerId of consumersByProvider.get(providerId) ?? []) {
      const remaining = remainingProviders.get(consumerId)! - 1;
      remainingProviders.set(consumerId, remaining);
      if (remaining === 0) pushCanonicalMinHeap(ready, consumerId);
    }
  }
  if (order.length !== components.length) {
    throw new Error(
      "semantic program condensation graph unexpectedly contains a cycle",
    );
  }
  return order;
}

function exactCoverage(
  nodes: readonly SemanticProgramCanonicalNodeInput[],
  selected: ReadonlySet<string>,
  ambient: ReadonlySet<string>,
  componentByNode: ReadonlyMap<string, SemanticProgramComponent>,
  regionByComponent: ReadonlyMap<string, ProjectedSemanticProgramRegion>,
): SemanticProgramCoverage {
  const entries = nodes.map((node): SemanticProgramCoverageEntry => {
    const component = requireComponent(componentByNode, node.id);
    return {
      nodeId: node.id,
      selected: selected.has(node.id),
      ambient: ambient.has(node.id),
      componentId: component.id,
      projectedRegionId: regionByComponent.get(component.id)?.id ?? null,
    };
  });
  const selectedNodeCount = entries.filter((entry) => entry.selected).length;
  if (entries.length !== nodes.length) {
    throw new Error("semantic program coverage is not exact");
  }
  return {
    nodeCount: entries.length,
    selectedNodeCount,
    externalNodeCount: entries.length - selectedNodeCount,
    entries,
  };
}

function externalComponentKey(
  baseContextDigest: string,
  component: SemanticProgramComponent,
  providerComponentKeys: readonly SemanticProgramProviderKey[],
): string {
  return `semantic-program-external-v${SEMANTIC_PROGRAM_GRAPH_VERSION}:${
    canonicalJsonSha256({
      version: SEMANTIC_PROGRAM_GRAPH_VERSION,
      kind: "external-only-component",
      baseContextDigest,
      componentId: component.id,
      componentInput: component.input,
      providerComponentKeys,
    })
  }`;
}

function semanticProgramRegionId(selectedNodeIds: readonly string[]): string {
  return `semantic-program-region-id-v${SEMANTIC_PROGRAM_GRAPH_VERSION}:${
    canonicalJsonSha256({ selectedNodeIds })
  }`;
}

function validatePlanShape(plan: SemanticProgramGraphPlan): void {
  if (plan.version !== SEMANTIC_PROGRAM_GRAPH_VERSION) {
    throw new TypeError(
      `unsupported semantic program graph version: ${String(plan.version)}`,
    );
  }
  canonicalIdentity(
    plan.baseContextDigest,
    "semantic program base context digest",
  );
  const componentIds = plan.components.map((component) => component.id);
  requireNoDuplicateValues(componentIds, "semantic program component id");
  requireNoDuplicateValues(plan.componentOrder, "semantic program component order id");
  const componentIdSet = new Set(componentIds);
  if (
    plan.componentOrder.length !== componentIds.length
    || plan.componentOrder.some((componentId) => !componentIdSet.has(componentId))
  ) {
    throw new TypeError(
      "semantic program component order does not exactly cover components",
    );
  }
  requireNoDuplicateValues(
    plan.regions.map((region) => region.id),
    "semantic program region id",
  );
}

function requireNoDuplicateValues(values: readonly string[], label: string): void {
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) throw new TypeError(`duplicate ${label}: ${value}`);
    seen.add(value);
  }
}

function requireUniqueGeneratedIds(values: readonly string[], label: string): void {
  const unique = new Set(values);
  if (unique.size !== values.length) {
    throw new Error(`semantic program ${label} content-address collision`);
  }
}

function requireComponent(
  componentByNode: ReadonlyMap<string, SemanticProgramComponent>,
  nodeId: string,
): SemanticProgramComponent {
  const component = componentByNode.get(nodeId);
  if (component === undefined) {
    throw new Error(`semantic program component is missing node: ${nodeId}`);
  }
  return component;
}

function requireKnownComponentId(
  componentById: ReadonlyMap<string, SemanticProgramComponent>,
  componentId: string,
): SemanticProgramComponent {
  const component = componentById.get(componentId);
  if (component === undefined) {
    throw new TypeError(
      `semantic program order contains unknown component: ${componentId}`,
    );
  }
  return component;
}

function requireAddressedKey(
  keyByComponent: ReadonlyMap<string, string>,
  componentId: string,
): string {
  const key = keyByComponent.get(componentId);
  if (key === undefined) {
    throw new Error(
      `semantic program provider was not addressed before consumer: ${componentId}`,
    );
  }
  return key;
}

function requireAddress(value: string, label: string): void {
  if (typeof value !== "string" || value.length === 0 || value.includes("\0")) {
    throw new TypeError(`${label} address must be a non-empty NUL-free string`);
  }
}

function compareDependencies(
  left: SemanticProgramDependency,
  right: SemanticProgramDependency,
): number {
  return compareCanonicalStrings(
    edgeIdentity(left.consumer, left.provider),
    edgeIdentity(right.consumer, right.provider),
  );
}

function edgeIdentity(consumer: string, provider: string): string {
  return `${consumer}\0${provider}`;
}

function compareStringArrays(
  left: readonly string[],
  right: readonly string[],
): number {
  const length = Math.min(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const compared = compareCanonicalStrings(left[index]!, right[index]!);
    if (compared !== 0) return compared;
  }
  return left.length - right.length;
}

function pushCanonicalMinHeap(heap: string[], value: string): void {
  let index = heap.length;
  heap.push(value);
  while (index > 0) {
    const parent = Math.floor((index - 1) / 2);
    if (compareCanonicalStrings(heap[parent]!, value) <= 0) break;
    heap[index] = heap[parent]!;
    index = parent;
  }
  heap[index] = value;
}

function popCanonicalMinHeap(heap: string[]): string | undefined {
  const first = heap[0];
  const last = heap.pop();
  if (first === undefined || last === undefined || heap.length === 0) {
    return first;
  }

  let index = 0;
  while (true) {
    const left = index * 2 + 1;
    if (left >= heap.length) break;
    const right = left + 1;
    const smallerChild = (
      right < heap.length
      && compareCanonicalStrings(heap[right]!, heap[left]!) < 0
    )
      ? right
      : left;
    if (compareCanonicalStrings(last, heap[smallerChild]!) <= 0) break;
    heap[index] = heap[smallerChild]!;
    index = smallerChild;
  }
  heap[index] = last;
  return first;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
