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

/** What the boundary occurrence does. Direction remains the compatibility/topology primitive;
 * operation preserves enough semantics for a causal reader to distinguish a notification from a
 * request, and a subscription site from the handler that answers a request. */
export type PortOperation = "notify" | "request" | "subscribe" | "handle" | "respond";

export interface Port {
  /** The callable (or module, for top-level sites) that registers or invokes the boundary. */
  nodeId: NodeId;
  /** Actual inbound callback when it has its own graph node; registration remains `nodeId`. */
  handlerNodeId?: NodeId;
  direction: PortDirection;
  /** Transport, open vocabulary: "http" | "electron" | "ws" | "queue" | ... */
  protocol: string;
  /** Normalized channel key ("GET /api/orders", "notes:load"); null when dynamic — never guessed. */
  channel: string | null;
  /** The raw text at the call site (original URL/first argument), for display and diagnostics. */
  label: string;
  callSite: CallSite;
  /** Stable built-in/project model that recognized this surface. Older artifacts omit it. */
  surfaceId?: string;
  /** Boundary semantics beyond the coarse in/out direction. Older artifacts omit it. */
  operation?: PortOperation;
  /** Transport route within a protocol, e.g. Electron renderer→main invoke vs message lanes. */
  lane?: string;
  /** Proven endpoint/bus identity. Equal channels in different scopes must never join. */
  scope?: string;
  /**
   * Artifact scopes identify a resource instance only inside the artifact that extracted it. The
   * linker namespaces them by system before joining. Missing remains globally comparable for
   * backward compatibility (for example a proven absolute URL origin).
   */
  scopeKind?: "global" | "artifact";
  /** Strength of the channel correlation. Omitted means exact/backward-compatible (1.0). */
  confidence?: number;
}

/** Channel node id: protocol plus optional transport lane/scope and the normalized channel.
 * Every component is named and URI-encoded so a lane can never be mistaken for a scope and
 * arbitrary static selector strings remain injective (`a b` cannot collide with `a+b`, etc.). */
export function channelNodeId(protocol: string, channel: string, lane?: string, scope?: string): NodeId {
  const qualifiers = [
    ...(lane === undefined ? [] : [`lane=${channelComponent(lane)}`]),
    ...(scope === undefined ? [] : [`scope=${channelComponent(scope)}`]),
    `channel=${channelComponent(channel)}`,
  ];
  return `ipc:${channelComponent(protocol)}/${qualifiers.join("/")}`;
}

function channelComponent(value: string): string {
  return encodeURIComponent(value);
}

/**
 * Materialize every literal-channel port into the graph: one `channel` node per distinct
 * (protocol, lane, scope, channel), a `sends` edge into it from each exit, a `handles` edge out of
 * it into each entry. Ports with `channel: null` (dynamic) materialize nothing — they stay
 * manifest-only.
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
  const channelGroups = new Map<string, {
    protocol: string;
    channel: string;
    lane: string | undefined;
    scope: string | undefined;
    confidence: number;
  }>();
  const rawEdges: RawGraphEdge[] = [];
  for (const port of literal) {
    const channel = port.channel as string;
    const id = channelNodeId(port.protocol, channel, port.lane, port.scope);
    const confidence = port.confidence ?? 1;
    const resolution = confidence >= 1 ? "resolved" : "unresolved";
    const group = channelGroups.get(id);
    if (group) group.confidence = Math.min(group.confidence, confidence);
    else channelGroups.set(id, {
      protocol: port.protocol,
      channel,
      lane: port.lane,
      scope: port.scope,
      confidence,
    });
    const endpoint = port.direction === "in" && port.handlerNodeId && known.has(port.handlerNodeId)
      ? port.handlerNodeId
      : port.nodeId;
    rawEdges.push(
      port.direction === "out"
        ? { source: port.nodeId, target: id, kind: SENDS_KIND, resolution, confidence, callSite: port.callSite }
        : { source: id, target: endpoint, kind: HANDLES_KIND, resolution, confidence, callSite: port.callSite },
    );
  }
  const channels = new Map<string, GraphNode>();
  for (const [id, group] of channelGroups) {
    if (!known.has(id)) {
      channels.set(id, channelNode(
        id,
        group.protocol,
        group.channel,
        group.lane,
        group.scope,
        group.confidence,
      ));
    }
  }
  const channelEdges = dedupeAgainst(edges, aggregateEdges(rawEdges));
  return { nodes: [...nodes, ...channels.values()], edges: [...edges, ...channelEdges] };
}

function channelNode(
  id: NodeId,
  protocol: string,
  channel: string,
  lane: string | undefined,
  scope: string | undefined,
  confidence: number,
): GraphNode {
  const qualifier = [lane, scope].filter(Boolean).join(" · ");
  return {
    id,
    kind: CHANNEL_KIND,
    qualifiedName: channel,
    displayName: channel,
    parentId: null,
    location: { file: `(${protocol})`, startLine: 1 },
    summary: confidence >= 1
      ? `${protocol} channel${qualifier ? ` (${qualifier})` : ""} — joined by exact static evidence`
      : `${protocol} selector${qualifier ? ` (${qualifier})` : ""} — candidate IPC correlation (${Math.round(confidence * 100)}% confidence)`,
    tags: [protocol, ...(lane ? [lane] : []), ...(confidence < 1 ? ["candidate"] : [])],
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
