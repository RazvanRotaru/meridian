/**
 * Cross-artifact linking: N per-repo artifacts → one system graph, joined ONLY by static evidence.
 *
 * Each source becomes a top-level `system` container (`sys:<name>`); its node ids are namespaced by
 * prefixing the module path with the system name so two repos' `src/index.ts` never collide.
 * Boundary ids (`ext:`/`unresolved:`) and channel ids (`ipc:`) are deliberately NOT namespaced —
 * they are the shared space systems meet in; channels are the join key.
 *
 * Channels are rebuilt from scratch over the merged port set (per-artifact channel nodes/edges are
 * stripped first), with one extra join rule: a concrete HTTP exit path is unified onto a matching
 * entry ROUTE TEMPLATE (`GET /api/orders/123` → `GET /api/orders/:id`) when exactly one template
 * fits. No runtime, no manual marking; an unmatched port stays a dangling channel — the finding.
 */

import type { FlowStep, LogicFlows } from "./flow";
import { buildNodeId, parseNodeId } from "./ids";
import { CHANNEL_KIND, HANDLES_KIND, SENDS_KIND, materializeChannels, matchRouteTemplate, type Port } from "./ports";
import type { GraphEdge, GraphNode, NodeId } from "./types";

export const SYSTEM_KIND = "system";

export interface LinkSource {
  /** Unique display/namespace name for this artifact (usually its target.name). */
  name: string;
  nodes: GraphNode[];
  edges: GraphEdge[];
  ports: Port[];
  /** Per-callable logic flows (`extensions.logicFlow`), keyed by node id — merged so the linked
   * graph keeps the Logic-flow view. Node ids (keys AND in-step call targets) are namespaced too. */
  logicFlow?: LogicFlows;
  /** CLI-declared app entry modules (`extensions.entryModules`) — namespaced and merged. */
  entryModules?: NodeId[];
}

export interface LinkJoinStats {
  systems: number;
  channels: number;
  /** Channels with at least one sender AND one handler in DIFFERENT systems — the real IPC edges. */
  crossSystemChannels: number;
  /** Channels with only one side present anywhere — someone talks and nobody listens (or vice versa). */
  danglingChannels: number;
  /** Concrete HTTP exit paths unified onto an entry route template. */
  httpTemplateJoins: number;
}

export interface LinkedGraph {
  nodes: GraphNode[];
  edges: GraphEdge[];
  ports: Port[];
  /** All sources' logic flows, keys and call targets namespaced, merged into one record. */
  logicFlow: LogicFlows;
  /** All sources' declared entry modules, namespaced, in source order. */
  entryModules: NodeId[];
  stats: LinkJoinStats;
}

export function linkArtifacts(sources: LinkSource[]): LinkedGraph {
  const nodes: GraphNode[] = [];
  const seen = new Set<string>();
  const edges: GraphEdge[] = [];
  const ports: Port[] = [];
  const logicFlow: LogicFlows = {};
  const entryModules: NodeId[] = [];
  for (const source of sources) {
    const stripped = stripChannels(source);
    const remap = (id: NodeId) => namespacedId(id, source.name);
    nodes.push(systemNode(source.name));
    for (const node of stripped.nodes) {
      const mapped = remapNode(node, source.name, remap);
      if (!seen.has(mapped.id)) {
        seen.add(mapped.id);
        nodes.push(mapped);
      }
    }
    edges.push(...stripped.edges.map((edge) => remapEdge(edge, source.name, remap)));
    ports.push(...stripped.ports.map((port) => remapPort(port, source.name, remap)));
    mergeLogicFlow(logicFlow, source.logicFlow, remap);
    entryModules.push(...(source.entryModules ?? []).map(remap));
  }
  const { unified, httpTemplateJoins } = unifyHttpChannels(ports);
  const materialized = materializeChannels(nodes, edges, unified);
  return {
    nodes: materialized.nodes,
    edges: materialized.edges,
    ports: unified,
    logicFlow,
    entryModules,
    stats: joinStats(sources.length, unified, materialized.nodes, httpTemplateJoins),
  };
}

/**
 * Merge one source's logic flows into the accumulator, namespacing every node id so the flows still
 * join on the linked graph's (now-prefixed) ids: the record KEYS (the callables) and every `call`
 * step's `target` are remapped; control-structure bodies recurse. Shared-space targets
 * (`ext:`/`unresolved:`/`ipc:`) pass through `remap` untouched, and `null` targets stay null.
 */
function mergeLogicFlow(into: LogicFlows, flows: LogicFlows | undefined, remap: (id: NodeId) => NodeId): void {
  if (!flows) {
    return;
  }
  for (const [id, steps] of Object.entries(flows)) {
    into[remap(id)] = steps.map((step) => remapStep(step, remap));
  }
}

function remapStep(step: FlowStep, remap: (id: NodeId) => NodeId): FlowStep {
  switch (step.kind) {
    case "call":
      return { ...step, target: step.target === null ? null : remap(step.target) };
    case "exit":
      return step; // no target to remap, no body to recurse into
    case "loop":
    case "callback":
      return { ...step, body: step.body.map((child) => remapStep(child, remap)) };
    case "branch":
      return {
        ...step,
        paths: step.paths.map((path) => ({ ...path, body: path.body.map((child) => remapStep(child, remap)) })),
      };
  }
}

/** Channels/`sends`/`handles` from per-artifact materialization are rebuilt over the merged ports. */
function stripChannels(source: LinkSource): LinkSource {
  return {
    ...source,
    nodes: source.nodes.filter((node) => node.kind !== CHANNEL_KIND),
    edges: source.edges.filter((edge) => edge.kind !== SENDS_KIND && edge.kind !== HANDLES_KIND),
  };
}

function systemNode(name: string): GraphNode {
  return {
    id: systemId(name),
    kind: SYSTEM_KIND,
    qualifiedName: name,
    displayName: name,
    parentId: null,
    location: { file: name, startLine: 1 },
    summary: "one linked artifact — a separately analyzed codebase/process",
  };
}

function systemId(name: string): NodeId {
  return `sys:${name.replace(/\s+/g, "-").replace(/#/g, "%23")}`;
}

/** Shared-space ids (`ext:`/`unresolved:`/`ipc:`) keep their identity; everything else namespaces. */
function namespacedId(id: NodeId, name: string): NodeId {
  const parts = parseNodeId(id);
  if (parts.lang === "ext" || parts.lang === "unresolved" || parts.lang === "ipc") {
    return id;
  }
  return buildNodeId({ ...parts, modulePath: `${name}/${parts.modulePath}` });
}

function remapNode(node: GraphNode, name: string, remap: (id: NodeId) => NodeId): GraphNode {
  const id = remap(node.id);
  if (id === node.id) {
    return node; // a shared-space node (boundary leaf/container) passes through untouched.
  }
  return {
    ...node,
    id,
    // A source root now nests under its system frame; deeper nodes keep their (remapped) parent.
    parentId: node.parentId ? remap(node.parentId) : systemId(name),
    location: { ...node.location, file: `${name}/${node.location.file}` },
  };
}

function remapEdge(edge: GraphEdge, name: string, remap: (id: NodeId) => NodeId): GraphEdge {
  const source = remap(edge.source);
  const target = remap(edge.target);
  return {
    ...edge,
    id: `${edge.kind}@${source}|${target}`,
    source,
    target,
    callSites: edge.callSites?.map((site) => ({ ...site, file: `${name}/${site.file}` })),
  };
}

function remapPort(port: Port, name: string, remap: (id: NodeId) => NodeId): Port {
  return { ...port, nodeId: remap(port.nodeId), callSite: { ...port.callSite, file: `${name}/${port.callSite.file}` } };
}

/**
 * Unify concrete HTTP exits onto entry route templates so both ends share one channel key. Only
 * exits move (an entry's template IS the canonical key); non-HTTP ports pass through untouched.
 */
function unifyHttpChannels(ports: Port[]): { unified: Port[]; httpTemplateJoins: number } {
  const templatesByMethod = new Map<string, string[]>();
  for (const port of ports) {
    if (port.direction !== "in" || port.protocol !== "http" || port.channel === null) {
      continue;
    }
    const { method, path } = splitHttpChannel(port.channel);
    templatesByMethod.set(method, [...(templatesByMethod.get(method) ?? []), path]);
  }
  let httpTemplateJoins = 0;
  const unified = ports.map((port) => {
    if (port.direction !== "out" || port.protocol !== "http" || port.channel === null) {
      return port;
    }
    const { method, path } = splitHttpChannel(port.channel);
    const template = matchRouteTemplate(path, templatesByMethod.get(method) ?? []);
    if (template === null || template === path) {
      return port;
    }
    httpTemplateJoins += 1;
    return { ...port, channel: `${method} ${template}` };
  });
  return { unified, httpTemplateJoins };
}

function splitHttpChannel(channel: string): { method: string; path: string } {
  const space = channel.indexOf(" ");
  return space === -1
    ? { method: "GET", path: channel }
    : { method: channel.slice(0, space), path: channel.slice(space + 1) };
}

function joinStats(
  systems: number,
  ports: Port[],
  nodes: GraphNode[],
  httpTemplateJoins: number,
): LinkJoinStats {
  const bySystemOf = (nodeId: NodeId) => nodeId.split("/")[0] ?? nodeId;
  const channelSides = new Map<string, { out: Set<string>; in: Set<string> }>();
  for (const port of ports) {
    if (port.channel === null) {
      continue;
    }
    const key = `${port.protocol}\u0000${port.channel}`;
    const sides = channelSides.get(key) ?? { out: new Set<string>(), in: new Set<string>() };
    sides[port.direction === "out" ? "out" : "in"].add(bySystemOf(port.nodeId));
    channelSides.set(key, sides);
  }
  let crossSystemChannels = 0;
  let danglingChannels = 0;
  for (const sides of channelSides.values()) {
    if (sides.out.size === 0 || sides.in.size === 0) {
      danglingChannels += 1;
    } else if ([...sides.out].some((sender) => [...sides.in].some((handler) => handler !== sender))) {
      crossSystemChannels += 1;
    }
  }
  return {
    systems,
    channels: nodes.filter((node) => node.kind === CHANNEL_KIND).length,
    crossSystemChannels,
    danglingChannels,
    httpTemplateJoins,
  };
}
