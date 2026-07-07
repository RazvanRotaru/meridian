/**
 * IPC ports: the statically detectable points where code talks ACROSS a process/system boundary.
 *
 * A port is one end of an IPC operation — an exit (fetch, ipcRenderer.send, producer.send) or an
 * entry (an express route, ipcMain.handle, a consumer). Static analysis cannot follow the wire, but
 * it CAN read the channel key (the route path, the IPC channel string, the topic) at both ends, so
 * matching ends join through a materialized CHANNEL pseudo-node: `sender → channel → handler`.
 *
 * Ports ride the artifact's `extensions.ports` (no schema change); channel nodes reuse the boundary
 * -node pattern with the `ipc:` pseudo-id language tag. Honest-resolution applies throughout: a
 * dynamic channel (variable, template with expressions) keeps `channel: null` and joins nothing.
 */

import { edgeId, aggregateEdges, type RawGraphEdge } from "./assembly";
import type { CallSite, GraphEdge, GraphNode, NodeId } from "./types";

export const PORTS_EXTENSION = "ports";
export const CHANNEL_KIND = "channel";
/** Edge kinds for the two halves of an IPC hop (open vocabulary, lint-registered). */
export const SENDS_KIND = "sends";
export const HANDLES_KIND = "handles";

export type PortDirection = "in" | "out";

export interface Port {
  /** The callable (or module, for top-level sites) that owns the call site. */
  nodeId: NodeId;
  direction: PortDirection;
  /** Transport, open vocabulary: "http" | "electron" | "ws" | "queue" | ... */
  protocol: string;
  /** Normalized channel key ("GET /api/orders", "notes:load"); null when dynamic — never guessed. */
  channel: string | null;
  /** The raw text at the call site (original URL/first argument), for display and diagnostics. */
  label: string;
  callSite: CallSite;
}

/** Channel node id: `ipc:<protocol>/<channel-slug>` — same grammar as every other pseudo-id. */
export function channelNodeId(protocol: string, channel: string): NodeId {
  return `ipc:${protocol}/${channelSlug(channel)}`;
}

/** The node-id grammar forbids whitespace and `#` in the module path; nothing else needs escaping. */
function channelSlug(channel: string): string {
  return channel.replace(/\s+/g, "+").replace(/#/g, "%23");
}

/**
 * Materialize every literal-channel port into the graph: one `channel` node per distinct
 * (protocol, channel), a `sends` edge into it from each exit, a `handles` edge out of it into each
 * entry. Ports with `channel: null` (dynamic) materialize nothing — they stay manifest-only.
 * A one-ended channel is deliberately kept: a dangling channel node IS the finding ("someone sends
 * on this and nobody here listens"). Idempotent per channel; edges aggregate by call site.
 */
export function materializeChannels(
  nodes: GraphNode[],
  edges: GraphEdge[],
  ports: Port[],
): { nodes: GraphNode[]; edges: GraphEdge[] } {
  const known = new Set(nodes.map((node) => node.id));
  const literal = ports.filter((port) => port.channel !== null && known.has(port.nodeId));
  if (literal.length === 0) {
    return { nodes, edges };
  }
  const channels = new Map<string, GraphNode>();
  const rawEdges: RawGraphEdge[] = [];
  for (const port of literal) {
    const channel = port.channel as string;
    const id = channelNodeId(port.protocol, channel);
    if (!channels.has(id) && !known.has(id)) {
      channels.set(id, channelNode(id, port.protocol, channel));
    }
    rawEdges.push(
      port.direction === "out"
        ? { source: port.nodeId, target: id, kind: SENDS_KIND, resolution: "resolved", callSite: port.callSite }
        : { source: id, target: port.nodeId, kind: HANDLES_KIND, resolution: "resolved", callSite: port.callSite },
    );
  }
  const channelEdges = dedupeAgainst(edges, aggregateEdges(rawEdges));
  return { nodes: [...nodes, ...channels.values()], edges: [...edges, ...channelEdges] };
}

function channelNode(id: NodeId, protocol: string, channel: string): GraphNode {
  return {
    id,
    kind: CHANNEL_KIND,
    qualifiedName: channel,
    displayName: channel,
    parentId: null,
    location: { file: `(${protocol})`, startLine: 1 },
    summary: `${protocol} channel — an IPC boundary joined by its channel key`,
    tags: [protocol],
  };
}

/** Linking re-materializes over already-channeled artifacts; existing edge ids must not repeat. */
function dedupeAgainst(existing: GraphEdge[], candidates: GraphEdge[]): GraphEdge[] {
  const seen = new Set(existing.map((edge) => edge.id));
  return candidates.filter((edge) => !seen.has(edge.id));
}

/**
 * Join a concrete HTTP request path onto route TEMPLATES (`/api/orders/123` → `/api/orders/:id`):
 * segment-wise match where a `:param`/`*` template segment accepts any concrete segment. Returns
 * the matched template, preferring the most specific (fewest wildcards); an exact tie between two
 * distinct templates is ambiguous, so it honestly matches nothing.
 */
export function matchRouteTemplate(concretePath: string, templates: readonly string[]): string | null {
  const candidates = templates
    .filter((template) => templateMatches(concretePath, template))
    .sort((a, b) => wildcardCount(a) - wildcardCount(b));
  if (candidates.length === 0) {
    return null;
  }
  if (candidates.length > 1 && wildcardCount(candidates[0]) === wildcardCount(candidates[1])) {
    return null;
  }
  return candidates[0];
}

function templateMatches(concretePath: string, template: string): boolean {
  const concrete = segmentsOf(concretePath);
  const parts = segmentsOf(template);
  if (concrete.length !== parts.length) {
    return false;
  }
  return parts.every((part, i) => isWildcard(part) || part === concrete[i]);
}

function segmentsOf(path: string): string[] {
  return path.split("/").filter((segment) => segment.length > 0);
}

function isWildcard(segment: string): boolean {
  return segment.startsWith(":") || segment === "*";
}

function wildcardCount(template: string): number {
  return segmentsOf(template).filter(isWildcard).length;
}

/** `sends`/`handles` edge id helper re-exported for tests and the linker. */
export { edgeId };
