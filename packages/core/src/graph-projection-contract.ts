/** Shared, strict protocol version for graph manifests, requests, responses, and identities. */
export const GRAPH_PROJECTION_PROTOCOL_VERSION = 6;

/** Maximum exact UTF-8 JSON body accepted for one canonical graph projection request. */
export const GRAPH_PROJECTION_MAX_REQUEST_BYTES = 64_000;

export type GraphProjectionContractView = "modules" | "service" | "ui" | "logic" | "review";

const GRAPH_PROJECTION_REVIEW_CURSOR = /^(?:page|file):(0|[1-9]\d{0,4})$/;

/** Exact canonical grammar for a bounded comparison-context coordinate. */
export function isGraphProjectionReviewCursor(value: unknown): value is string {
  return typeof value === "string" && GRAPH_PROJECTION_REVIEW_CURSOR.test(value);
}

export type GraphProjectionReviewSide = "head" | "mergeBase";

export interface GraphProjectionReviewStatusCounts {
  readonly added: number;
  readonly modified: number;
  readonly deleted: number;
  readonly renamed: number;
}

export interface GraphProjectionReviewFile {
  readonly index: number;
  readonly path: string;
  readonly status: "added" | "modified" | "deleted" | "renamed";
  readonly previousPath?: string;
}

export interface GraphProjectionReviewPageFacts {
  readonly index: number;
  readonly entries: readonly GraphProjectionReviewFile[];
  readonly statusCounts: GraphProjectionReviewStatusCounts;
  readonly previousCursor: string | null;
  readonly nextCursor: string | null;
}

export interface GraphProjectionReviewSelectionFacts {
  readonly index: number;
  readonly entry: GraphProjectionReviewFile;
  readonly graphPath: string | null;
  readonly graphMatched: boolean;
}

/** Bounded metadata facts returned for one page or one selected comparison file. */
export interface GraphProjectionReviewFacts {
  readonly contextId: string;
  readonly side: GraphProjectionReviewSide;
  readonly totalFiles: number;
  readonly statusCounts: GraphProjectionReviewStatusCounts;
  readonly pageCount: number;
  readonly page: GraphProjectionReviewPageFacts | null;
  readonly selection: GraphProjectionReviewSelectionFacts | null;
}

/** Structural request contract used only after each boundary has performed its own validation. */
export interface GraphProjectionContractRequest {
  readonly version: typeof GRAPH_PROJECTION_PROTOCOL_VERSION;
  readonly view: GraphProjectionContractView;
  readonly filePaths: readonly string[];
  /**
   * Opaque, capability-bound review coordinate. Prepared comparisons use `page:N` for a bounded
   * manifest page and `file:N` for one exact changed file. The server resolves the coordinate from
   * immutable comparison context; changed paths never need to cross the request boundary.
   */
  readonly reviewCursor: string | null;
  readonly focusIds: readonly string[];
  readonly expandedIds: readonly string[];
  readonly extraIds: readonly string[];
  readonly causalIds: readonly string[];
  readonly serviceExpandedLeadIds: readonly string[];
  readonly depth: number;
  readonly includeTests: boolean;
  readonly includeReachability: boolean;
  readonly maxNodes: number;
  readonly maxEdges: number;
  readonly maxResponseBytes: number;
}

/** Exact v6 field set in the one order used for transport keys and cryptographic identity. */
export const GRAPH_PROJECTION_REQUEST_FIELDS = [
  "version",
  "view",
  "filePaths",
  "reviewCursor",
  "focusIds",
  "expandedIds",
  "extraIds",
  "causalIds",
  "serviceExpandedLeadIds",
  "depth",
  "includeTests",
  "includeReachability",
  "maxNodes",
  "maxEdges",
  "maxResponseBytes",
] as const satisfies readonly (keyof GraphProjectionContractRequest)[];

/**
 * Serialize an already validated and value-canonical request independently of object insertion
 * order. This is the only JSON representation allowed in projection cache and identity inputs.
 */
export function canonicalGraphProjectionRequestJson(
  request: GraphProjectionContractRequest,
): string {
  return JSON.stringify({
    version: request.version,
    view: request.view,
    filePaths: request.filePaths,
    reviewCursor: request.reviewCursor,
    focusIds: request.focusIds,
    expandedIds: request.expandedIds,
    extraIds: request.extraIds,
    causalIds: request.causalIds,
    serviceExpandedLeadIds: request.serviceExpandedLeadIds,
    depth: request.depth,
    includeTests: request.includeTests,
    includeReachability: request.includeReachability,
    maxNodes: request.maxNodes,
    maxEdges: request.maxEdges,
    maxResponseBytes: request.maxResponseBytes,
  });
}

/** Exact SHA-256 input shared by Node and browser implementations of projection identity. */
export function graphProjectionIdentityPreimage(
  contentId: string,
  request: GraphProjectionContractRequest,
): string {
  return `projection-v${GRAPH_PROJECTION_PROTOCOL_VERSION}\0${contentId}\0${canonicalGraphProjectionRequestJson(request)}`;
}
