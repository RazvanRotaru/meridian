/** Shared, strict protocol version for graph manifests, requests, responses, and identities. */
export const GRAPH_PROJECTION_PROTOCOL_VERSION = 9;

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
  /** Canonical graph-backed verdict for this side, or null when the path is absent or unmapped. */
  readonly isTest: boolean | null;
}

/** Graph-backed test truth for one canonical changed-file coordinate. */
export interface GraphProjectionReviewTestClassification {
  readonly index: number;
  readonly isTest: boolean;
}

/** Immutable, graph-free classification truth shared by every coordinate of one PR comparison. */
export interface GraphProjectionReviewMetadata {
  readonly version: 1;
  readonly metadataId: string;
  readonly contextId: string;
  readonly headGraphId: string;
  readonly mergeBaseGraphId: string;
  readonly headContentId: string;
  readonly mergeBaseContentId: string;
  readonly totalFiles: number;
  readonly testClassifications: readonly GraphProjectionReviewTestClassification[];
}

export type GraphProjectionReviewMetadataIdentity = Pick<
  GraphProjectionReviewMetadata,
  | "contextId"
  | "headGraphId"
  | "mergeBaseGraphId"
  | "headContentId"
  | "mergeBaseContentId"
>;

/** Exact SHA-256 input binding review metadata to both immutable graph capabilities. */
export function graphProjectionReviewMetadataIdentityPreimage(
  identity: GraphProjectionReviewMetadataIdentity,
): string {
  return [
    "review-metadata-v1",
    identity.contextId,
    identity.headGraphId,
    identity.mergeBaseGraphId,
    identity.headContentId,
    identity.mergeBaseContentId,
  ].join("\0");
}

export type GraphProjectionReviewOverviewEntryState =
  | "included"
  | "unmapped"
  | "filtered"
  | "deferred"
  | "absent";

/** Exact graph coverage for the manifest page carried by one overview coordinate. */
export interface GraphProjectionReviewOverviewFacts {
  readonly entries: readonly {
    readonly index: number;
    readonly state: GraphProjectionReviewOverviewEntryState;
    /**
     * Canonical graph-backed test classification for this side's source path. Null means that side
     * has no indexed graph path (`absent` or `unmapped`); mapped entries retain the verdict even
     * when the representative is filtered by Tests or deferred by a response budget.
     */
    readonly isTest: boolean | null;
  }[];
}

/** Bounded metadata facts returned for one page or one selected comparison file. */
export interface GraphProjectionReviewFacts {
  readonly contextId: string;
  /** Digest of the immutable comparison metadata required to interpret this coordinate. */
  readonly metadataId: string;
  readonly side: GraphProjectionReviewSide;
  readonly totalFiles: number;
  readonly statusCounts: GraphProjectionReviewStatusCounts;
  readonly pageCount: number;
  readonly page: GraphProjectionReviewPageFacts | null;
  readonly selection: GraphProjectionReviewSelectionFacts | null;
  /** Null for exact file coordinates; present for overview/page coordinates. */
  readonly overview: GraphProjectionReviewOverviewFacts | null;
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

/** Exact v9 field set in the one order used for transport keys and cryptographic identity. */
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
