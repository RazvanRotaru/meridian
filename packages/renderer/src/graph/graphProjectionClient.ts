/**
 * HTTP transport for disk-backed graph projections.
 *
 * A projection is still a valid GraphArtifact, but it contains only the nodes, edges, and
 * extension slices needed by one renderer view. The currently displayed projection is pinned;
 * decoded projections visited recently live in a byte-bounded LRU so browser Back/Forward can be
 * instant without letting navigation rebuild an unbounded in-memory graph cache.
 */

import {
  GRAPH_PROJECTION_MAX_REQUEST_BYTES,
  GRAPH_PROJECTION_PROTOCOL_VERSION,
  GRAPH_PROJECTION_REQUEST_FIELDS,
  canonicalGraphProjectionRequestJson,
  compareCanonicalPrPreparePaths,
  deriveGraphStructure,
  graphProjectionIdentityPreimage,
  graphProjectionReviewMetadataIdentityPreimage,
  isGraphProjectionReviewCursor,
  parseGraphModuleOverview,
  parseReachabilityProjectionFacts,
} from "@meridian/core";
import type {
  GraphArtifact,
  GraphHierarchyFact,
  GraphModuleOverview,
  GraphProjectionReviewFacts,
  GraphProjectionReviewFile,
  GraphProjectionReviewMetadata,
  GraphProjectionReviewStatusCounts,
  GraphRepositorySummary,
  GraphStructureFacts,
  ReachabilityProjectionFacts,
} from "@meridian/core";
import {
  parseSerializedServiceTopology,
  type SerializedServiceTopologyV1,
} from "@meridian/design-metrics";
import {
  buildGraphIndex,
  estimateGraphPresentationResidentBytes,
  type GraphIndex,
} from "./graphIndex";
import {
  DEFAULT_RECENT_ALLOCATION_BUDGET_LIMITS,
  RecentAllocationBudget,
  RecentViewProjectionCache,
  type RecentViewProjectionCacheLimits,
} from "../state/recentViewProjectionCache";
import { PERFORMANCE, startPerformanceSpan } from "../boot/performanceMarks";
import {
  GRAPH_SYMBOL_SEARCH_VERSION,
  MAX_GRAPH_SYMBOL_RESULTS,
  type GraphSymbolEntry,
  type GraphSymbolSearchRequest,
  type GraphSymbolSearchResult,
} from "./graphSymbolSearch";

const SUPPORTED_SCHEMA_MAJOR = 1;
const DEFAULT_RESIDENT_EXPANSION_FACTOR = 3;
/** One bounded response buffer plus worst-case UTF-16 decode text, released after JSON parsing. */
const TRANSIENT_RESPONSE_EXPANSION_FACTOR = 3;
const MAX_MANIFEST_CACHE_ENTRIES = 16;
const MAX_IN_FLIGHT_MANIFESTS = 16;
const MAX_IN_FLIGHT_PROJECTIONS = 32;
const MAX_FOCUS_IDS = 32;
const MAX_EXPANDED_IDS = 512;
const MAX_EXTRA_IDS = 128;
const MAX_CAUSAL_IDS = 2_000;
const MAX_ID_BYTES = 2_048;
const MAX_CAUSAL_IDS_BYTES = 256 * 1024;
const MAX_FILE_PATHS = 512;
const MAX_FILE_PATH_BYTES = 2_048;
const MAX_FILE_PATHS_BYTES = 48 * 1024;
const DEFAULT_MAX_NODES = 5_000;
const DEFAULT_MAX_EDGES = 20_000;
const DEFAULT_MAX_RESPONSE_BYTES = 16 * 1024 * 1024;
const MIN_MAX_RESPONSE_BYTES = 64 * 1024;
/** Two default-sized response+decode+index lanes; one two-sided review always fits. */
const MAX_IN_FLIGHT_ESTIMATED_RESIDENT_BYTES = 192 * 1024 * 1024;
const MAX_PENDING_PROJECTION_ENTRIES = 4;
const MAX_MANIFEST_RESPONSE_BYTES = 64 * 1024;
const MAX_REVIEW_METADATA_RESPONSE_BYTES = 8 * 1024 * 1024;
const MAX_IN_FLIGHT_REVIEW_METADATA = 4;
const MAX_SYMBOL_SEARCH_QUERY_BYTES = 256;
const MAX_SYMBOL_SEARCH_RESPONSE_BYTES = 512 * 1024;
const PROJECTION_MANIFEST_FIELDS = [
  "version", "graphId", "contentId", "graphSummary", "repositorySummary", "defaultView",
] as const;
const PROJECTION_RESPONSE_FIELDS = [
  "version", "contentId", "projectionId", "request", "artifact", "hierarchy", "viewFacts", "analysis",
  "completeness", "residentBytes",
] as const;
const PROJECTION_COMPLETENESS_FIELDS = [
  "complete", "reasons", "omittedNodes", "omittedEdges",
] as const;
const PROJECTION_VIEW_FACT_FIELDS = ["moduleOverview", "service", "review"] as const;
const PROJECTION_ANALYSIS_FIELDS = ["reachability"] as const;
const EMPTY_MODULE_OVERVIEW: GraphModuleOverview = Object.freeze({ roots: [], edges: [] });

export type GraphProjectionView =
  | "modules"
  | "service"
  | "ui"
  | "logic"
  | "review";

/** The renderer/server projection contract. Every id collection is canonicalized before use. */
export interface GraphProjectionRequest {
  version: typeof GRAPH_PROJECTION_PROTOCOL_VERSION;
  view: GraphProjectionView;
  /** Canonical root-relative POSIX paths used to route PR review slices on both revisions. */
  filePaths: readonly string[];
  /** Capability-bound page/file coordinate. Paths never cross this boundary for prepared reviews. */
  reviewCursor: string | null;
  focusIds: readonly string[];
  expandedIds: readonly string[];
  extraIds: readonly string[];
  causalIds: readonly string[];
  serviceExpandedLeadIds: readonly string[];
  depth: number;
  includeTests: boolean;
  includeReachability: boolean;
  maxNodes: number;
  maxEdges: number;
  maxResponseBytes: number;
}

export interface GraphProjectionManifest {
  version: typeof GRAPH_PROJECTION_PROTOCOL_VERSION;
  graphId: string;
  contentId: string;
  graphSummary: {
    schemaVersion: string;
    generatedAt: string;
    nodeCount: number;
    edgeCount: number;
  };
  repositorySummary: GraphRepositorySummary;
  defaultView: GraphProjectionRequest;
}

export interface LoadedGraphProjection {
  /** Stable renderer-side key for this graph + canonical view request. */
  key: string;
  /** Content identity returned by the server. */
  projectionId: string;
  graphId: string;
  request: GraphProjectionRequest;
  artifact: GraphArtifact;
  index: GraphIndex;
  /** Full-revision summary/diagnostics plus paint facts only for this bounded node slice. */
  reachability: ReachabilityProjectionFacts | null;
  /** Bounded status rollup or exact selected-file facts for a prepared comparison capability. */
  review: GraphProjectionReviewFacts | null;
  serializedBytes: number;
  /** Conservative estimate charged to the inactive decoded-view LRU. */
  residentBytes: number;
}

/** HEAD and merge-base are one active review allocation and one eviction unit. */
export interface LoadedReviewProjection {
  key: string;
  projectionId: string;
  head: LoadedGraphProjection;
  mergeBase: LoadedGraphProjection;
  /** One shared immutable catalog object for every coordinate in this comparison. */
  reviewMetadata: GraphProjectionReviewMetadata;
  /** Shared catalog charge, accounted once by the client rather than once per coordinate. */
  reviewMetadataResidentBytes: number;
  serializedBytes: number;
  residentBytes: number;
}

export interface GraphProjectionEndpoints {
  /** Immutable graph identity expected from every endpoint in this capability. */
  graphId: string;
  manifestUrl: string;
  projectionUrl: string;
  searchUrl: string;
}

export interface GraphProjectionActivateOptions {
  /** Exact immutable transport pair for the graph being read. */
  endpoints: GraphProjectionEndpoints;
  signal?: AbortSignal;
}

export interface GraphProjectionReviewPairOptions {
  head: { request: GraphProjectionRequest; endpoints: GraphProjectionEndpoints };
  mergeBase: { request: GraphProjectionRequest; endpoints: GraphProjectionEndpoints };
  signal?: AbortSignal;
}

/**
 * A decoded two-sided review candidate which has not changed renderer ownership yet.
 *
 * While staged, the candidate is charged to a dedicated pending-owner budget sized for max-response
 * decode liability. `commit` transfers ownership into the active projection cache synchronously;
 * `release` drops an uncommitted candidate. The smaller Back/Forward cache is unaffected until a
 * real active view is replaced. Access after pending-budget eviction or release fails closed.
 */
export interface StagedProjection<Projection> {
  readonly projection: Projection;
  /**
   * Transfer this candidate into the active cache. `supersededKeys` are decoded coordinates which
   * became unreachable as part of the same semantic transition and must not be offered to the
   * Back/Forward LRU. Reachable prior views remain recent by default.
   */
  commit(options?: ProjectionCommitOptions): Projection;
  release(): void;
}

export interface ProjectionCommitOptions {
  readonly supersededKeys?: readonly string[];
}

export type StagedGraphProjection = StagedProjection<LoadedGraphProjection>;
export type StagedReviewProjection = StagedProjection<LoadedReviewProjection>;

export interface GraphProjectionDataSource {
  readonly activeKey: string | undefined;
  loadManifest(options: GraphProjectionActivateOptions): Promise<GraphProjectionManifest>;
  stage(
    request: GraphProjectionRequest,
    options: GraphProjectionActivateOptions,
  ): Promise<StagedGraphProjection>;
  stageReviewPair(options: GraphProjectionReviewPairOptions): Promise<StagedReviewProjection>;
  stageCached(key: string): StagedGraphProjection | undefined;
  stageCachedReview(key: string): StagedReviewProjection | undefined;
  /** Release every inactive review pair while preserving the projection currently in use. */
  discardInactiveReviewProjections(): void;
  searchSymbols(
    request: GraphSymbolSearchRequest,
    options: GraphProjectionActivateOptions,
  ): Promise<GraphSymbolSearchResult>;
}

export interface GraphProjectionClientOptions {
  fetch?: typeof fetch;
  /** Multiplier from serialized response bytes to decoded artifact + index heap estimate. */
  residentExpansionFactor?: number;
  recentCache?: Partial<RecentViewProjectionCacheLimits>;
  /** Optional browser-wide coordinator shared with decoded scene/navigation caches. */
  recentBudget?: RecentAllocationBudget;
  /** Optional coordinator for decoded candidates awaiting validation/CAS before becoming active. */
  pendingBudget?: RecentAllocationBudget;
}

export class GraphProjectionClient implements GraphProjectionDataSource {
  private readonly fetchImpl: typeof fetch;
  private readonly residentExpansionFactor: number;
  private readonly cache: RecentViewProjectionCache<string, CachedProjection>;
  private readonly recentBudget: RecentAllocationBudget;
  private readonly pendingBudget: RecentAllocationBudget;
  /** Settled manifests are a small LRU; live reads remain separately bounded and cancellable. */
  private readonly manifests = new Map<string, GraphProjectionManifest>();
  private readonly inFlightManifests = new Map<string, SharedProjectionFlight<GraphProjectionManifest>>();
  /** Single and composite reads share side flights, so a concurrent HEAD-only + review-pair read
   * decodes/indexes that HEAD exactly once. Each flight aborts only after its final subscriber. */
  private readonly inFlightSides = new Map<string, SharedDecodedProjectionFlight<LoadedGraphProjection>>();
  private readonly inFlightReviews = new Map<string, SharedDecodedProjectionFlight<LoadedReviewProjection>>();
  private readonly inFlightReviewMetadata = new Map<
    string,
    SharedProjectionFlight<LoadedReviewMetadataDocument>
  >();
  /** One settled whole-manifest catalog; coordinate pairs share it by reference. */
  private reviewMetadata: { key: string; document: LoadedReviewMetadataDocument } | null = null;
  private readonly decodeAdmission: ProjectionDecodeAdmission;
  private decodedTransferOwners = 0;
  /** String-only aliases keep a cached review pair as the sole owner of both decoded sides. */
  private readonly reviewSideAliases = new Map<string, ReviewSideAlias>();

  constructor(options: GraphProjectionClientOptions = {}) {
    // Browser-native fetch performs a Web IDL receiver check. Keeping it as an object field and
    // calling `this.fetchImpl(...)` would otherwise supply the GraphProjectionClient as `this`,
    // which Chromium rejects with "Illegal invocation". Injected test/custom fetches retain their
    // own call contract; only the native global needs binding.
    this.fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.residentExpansionFactor = positiveFinite(
      options.residentExpansionFactor ?? DEFAULT_RESIDENT_EXPANSION_FACTOR,
      "residentExpansionFactor",
    );
    const inFlightResidentBytes = Math.max(
      MAX_IN_FLIGHT_ESTIMATED_RESIDENT_BYTES,
      estimatedDecodeLiability(
        DEFAULT_MAX_RESPONSE_BYTES * 2,
        Math.max(this.residentExpansionFactor, DEFAULT_RESIDENT_EXPANSION_FACTOR)
          + TRANSIENT_RESPONSE_EXPANSION_FACTOR,
      ),
    );
    this.decodeAdmission = new ProjectionDecodeAdmission(inFlightResidentBytes);
    this.pendingBudget = options.pendingBudget ?? new RecentAllocationBudget({
      maxRecentEntries: MAX_PENDING_PROJECTION_ENTRIES,
      maxRecentBytes: inFlightResidentBytes,
    });
    const recentLimits = {
      maxRecentEntries: options.recentCache?.maxRecentEntries
        ?? DEFAULT_RECENT_ALLOCATION_BUDGET_LIMITS.maxRecentEntries,
      maxRecentBytes: options.recentCache?.maxRecentBytes
        ?? DEFAULT_RECENT_ALLOCATION_BUDGET_LIMITS.maxRecentBytes,
    };
    this.recentBudget = options.recentBudget ?? new RecentAllocationBudget(recentLimits);
    this.cache = new RecentViewProjectionCache(recentLimits, this.recentBudget);
  }

  get activeKey(): string | undefined {
    return this.cache.activeKey;
  }

  /** Bytes charged from network admission through transfer into pending projection ownership. */
  get decodeAdmissionResidentByteLength(): number {
    return this.decodeAdmission.residentByteLength;
  }

  get queuedDecodeCount(): number {
    return this.decodeAdmission.queuedCount;
  }

  /** Number of physically decoded side allocations transferring through subscribers/aggregation. */
  get decodedTransferOwnerCount(): number {
    return this.decodedTransferOwners;
  }

  /** Parsed whole-manifest review metadata retained outside coordinate projection entries. */
  get reviewMetadataResidentByteLength(): number {
    return this.reviewMetadata?.document.residentBytes ?? 0;
  }

  /** Active + inactive coordinate allocations plus the one shared review catalog. */
  get retainedResidentByteLength(): number {
    const active = this.cache.active;
    const activeBytes = active === undefined
      ? 0
      : active.kind === "review" ? active.projection.residentBytes : active.projection.residentBytes;
    return safeByteSum(
      safeByteSum(activeBytes, this.cache.recentResidentByteLength),
      this.reviewMetadataResidentByteLength,
    );
  }

  async loadManifest(options: GraphProjectionActivateOptions): Promise<GraphProjectionManifest> {
    const url = options.endpoints.manifestUrl;
    throwIfAborted(options.signal);
    const cached = this.manifests.get(url);
    if (cached !== undefined) {
      assertExpectedManifestGraph(cached, options.endpoints.graphId);
      // Promote a reused graph to the MRU end. Prepared graph ids are unbounded over a long-lived
      // session, so this small LRU must not degrade into a process-lifetime manifest registry.
      this.manifests.delete(url);
      this.manifests.set(url, cached);
      return cached;
    }
    const loaded = await this.subscribeProjection(
      this.inFlightManifests,
      url,
      (signal) => fetchManifest(this.fetchImpl, url, signal),
      options.signal,
      MAX_IN_FLIGHT_MANIFESTS,
      "too many graph manifests are already in flight",
    );
    throwIfAborted(options.signal);
    assertExpectedManifestGraph(loaded, options.endpoints.graphId);
    this.manifests.delete(url);
    this.manifests.set(url, loaded);
    evictOldest(this.manifests, MAX_MANIFEST_CACHE_ENTRIES);
    return loaded;
  }

  async stage(
    request: GraphProjectionRequest,
    options: GraphProjectionActivateOptions,
  ): Promise<StagedGraphProjection> {
    const canonical = canonicalizeProjectionRequest(request);
    const manifest = await this.loadManifest(options);
    throwIfAborted(options.signal);
    const key = canonicalProjectionKey(manifest.graphId, canonical);
    const aliased = this.peekReviewSideAlias(key);
    if (aliased !== undefined) {
      return this.stageDecodedGraph(aliased.projection, key, aliased.reviewKey);
    }
    const cached = this.cache.peek(key);
    if (cached?.kind === "single") {
      return this.stageDecodedGraph(cached.projection, key);
    }
    const projectionEndpoint = options.endpoints.projectionUrl;
    const decoded = await this.subscribeDecodedProjection(
      this.inFlightSides,
      key,
      (signal) => this.decodeWithAdmission(
        canonical,
        signal,
        () => this.fetchProjection(manifest, canonical, projectionEndpoint, signal),
      ),
      options.signal,
    );
    try {
      throwIfAborted(options.signal);
      const publishedReviewSide = this.peekReviewSideAlias(key);
      if (publishedReviewSide !== undefined) {
        return this.stageDecodedGraph(
          publishedReviewSide.projection,
          key,
          publishedReviewSide.reviewKey,
        );
      }
      const publishedSingle = this.cache.peek(key);
      return this.stageDecodedGraph(
        publishedSingle?.kind === "single" ? publishedSingle.projection : decoded.projection,
        key,
      );
    } finally {
      // `stageDecodedGraph` synchronously registers pending ownership before this transferable
      // decode reservation leaves. Validation/cancellation paths dispose it without publication.
      decoded.release();
    }
  }

  async stageReviewPair(options: GraphProjectionReviewPairOptions): Promise<StagedReviewProjection> {
    const headRequest = canonicalizeProjectionRequest(options.head.request);
    const mergeBaseRequest = canonicalizeProjectionRequest(options.mergeBase.request);
    if (headRequest.view !== "review" || mergeBaseRequest.view !== "review") {
      throw new TypeError("review projection pairs require view: review on both revisions");
    }
    const [headManifest, mergeBaseManifest] = await loadAtomicPair(
      options.signal,
      (pairSignal) => this.loadManifest({ endpoints: options.head.endpoints, signal: pairSignal }),
      (pairSignal) => this.loadManifest({ endpoints: options.mergeBase.endpoints, signal: pairSignal }),
    );
    throwIfAborted(options.signal);
    const headKey = canonicalProjectionKey(headManifest.graphId, headRequest);
    const mergeBaseKey = canonicalProjectionKey(mergeBaseManifest.graphId, mergeBaseRequest);
    const key = canonicalReviewProjectionKey(headKey, mergeBaseKey);
    const cached = this.cache.peek(key);
    if (cached?.kind === "review") {
      return this.stageDecodedReview(cached.projection, headKey, mergeBaseKey);
    }

    // Decode/index both sides and verify their one shared immutable metadata document before
    // publishing either. A malformed or stale lane cannot replace a usable review.
    const decoded = await this.subscribeDecodedProjection(this.inFlightReviews, key, async (reviewSignal) => {
      const [reviewMetadataDocument, sideOwners] = await loadAtomicPair(
        reviewSignal,
        (pairSignal) => this.loadReviewMetadata(
          headManifest,
          mergeBaseManifest,
          options.head.endpoints,
          options.mergeBase.endpoints,
          pairSignal,
        ),
        (pairSignal) => loadAtomicPair(
          pairSignal,
          (sideSignal) => this.subscribeDecodedProjection(
            this.inFlightSides,
            headKey,
            (signal) => this.decodeWithAdmission(
              headRequest,
              signal,
              () => this.fetchProjection(
                headManifest,
                headRequest,
                options.head.endpoints.projectionUrl,
                signal,
              ),
            ),
            sideSignal,
          ),
          (sideSignal) => this.subscribeDecodedProjection(
            this.inFlightSides,
            mergeBaseKey,
            (signal) => this.decodeWithAdmission(
              mergeBaseRequest,
              signal,
              () => this.fetchProjection(
                mergeBaseManifest,
                mergeBaseRequest,
                options.mergeBase.endpoints.projectionUrl,
                signal,
              ),
            ),
            sideSignal,
          ),
          {
            disposeLeft: (owner) => owner.release(),
            disposeRight: (owner) => owner.release(),
          },
        ),
        {
          disposeRight: ([headOwner, mergeBaseOwner]) => {
            headOwner.release();
            mergeBaseOwner.release();
          },
        },
      );
      const [headOwner, mergeBaseOwner] = sideOwners;
      try {
        const head = headOwner.projection;
        const mergeBase = mergeBaseOwner.projection;
        const reviewMetadata = reviewMetadataDocument.metadata;
        assertReviewMetadataMatchesProjections(reviewMetadata, head, mergeBase);
        const projection: LoadedReviewProjection = {
          key,
          projectionId: `${head.projectionId}\u0000${mergeBase.projectionId}`,
          head,
          mergeBase,
          reviewMetadata,
          reviewMetadataResidentBytes: reviewMetadataDocument.residentBytes,
          serializedBytes: safeByteSum(head.serializedBytes, mergeBase.serializedBytes),
          residentBytes: safeByteSum(
            safeByteSum(head.residentBytes, mergeBase.residentBytes),
            estimateGraphPresentationResidentBytes(
              head.artifact.nodes.length + mergeBase.artifact.nodes.length,
              head.artifact.edges.length,
            ),
          ),
        };
        return new TransferableDecodedProjection(projection, () => {
          headOwner.release();
          mergeBaseOwner.release();
        });
      } catch (error) {
        headOwner.release();
        mergeBaseOwner.release();
        throw error;
      }
    }, options.signal);
    try {
      throwIfAborted(options.signal);
      return this.stageDecodedReview(decoded.projection, headKey, mergeBaseKey);
    } finally {
      decoded.release();
    }
  }

  stageCached(key: string): StagedGraphProjection | undefined {
    const aliased = this.peekReviewSideAlias(key);
    if (aliased !== undefined) {
      return this.stageDecodedGraph(aliased.projection, key, aliased.reviewKey);
    }
    const cached = this.cache.peek(key);
    return cached?.kind === "single"
      ? this.stageDecodedGraph(cached.projection, key)
      : undefined;
  }

  stageCachedReview(key: string): StagedReviewProjection | undefined {
    const cached = this.cache.peek(key);
    if (cached?.kind !== "review") return undefined;
    return this.stageDecodedReview(
      cached.projection,
      cached.projection.head.key,
      cached.projection.mergeBase.key,
    );
  }

  discardInactiveReviewProjections(): void {
    this.cache.discardRecentWhere((_key, cached) => cached.kind === "review");
    this.pruneReviewSideAliases();
    const active = this.cache.activeKey === undefined
      ? undefined
      : this.cache.peek(this.cache.activeKey);
    if (active?.kind !== "review") this.reviewMetadata = null;
  }

  private async loadReviewMetadata(
    headManifest: GraphProjectionManifest,
    mergeBaseManifest: GraphProjectionManifest,
    headEndpoints: GraphProjectionEndpoints,
    mergeBaseEndpoints: GraphProjectionEndpoints,
    signal?: AbortSignal,
  ): Promise<LoadedReviewMetadataDocument> {
    const endpoint = reviewMetadataEndpoint(headEndpoints.projectionUrl);
    const key = JSON.stringify([
      headEndpoints.graphId,
      mergeBaseEndpoints.graphId,
      headManifest.contentId,
      mergeBaseManifest.contentId,
    ]);
    throwIfAborted(signal);
    if (this.reviewMetadata?.key === key) return this.reviewMetadata.document;
    return this.subscribeProjection(
      this.inFlightReviewMetadata,
      key,
      async (flightSignal) => {
        const liability = estimatedDecodeLiability(
          MAX_REVIEW_METADATA_RESPONSE_BYTES,
          DEFAULT_RESIDENT_EXPANSION_FACTOR + TRANSIENT_RESPONSE_EXPANSION_FACTOR,
        );
        const release = await this.decodeAdmission.acquire(liability, flightSignal);
        try {
          return await fetchReviewMetadata(
            this.fetchImpl,
            endpoint,
            headManifest,
            mergeBaseManifest,
            headEndpoints,
            mergeBaseEndpoints,
            flightSignal,
          );
        } finally {
          release();
        }
      },
      signal,
      MAX_IN_FLIGHT_REVIEW_METADATA,
      "too many review metadata documents are already in flight",
    );
  }

  async searchSymbols(
    request: GraphSymbolSearchRequest,
    options: GraphProjectionActivateOptions,
  ): Promise<GraphSymbolSearchResult> {
    const canonical = canonicalizeSymbolSearchRequest(request);
    const manifest = await this.loadManifest(options);
    throwIfAborted(options.signal);
    const endpoint = options.endpoints.searchUrl;
    const response = await this.fetchImpl(endpoint, {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify(canonical),
      signal: options.signal,
    });
    if (!response.ok) {
      await cancelUnreadResponse(response, "graph symbol search request failed");
      throw new Error(`graph symbol search failed (${response.status}) from ${response.url || endpoint}`);
    }
    const bytes = await readBoundedResponse(response, MAX_SYMBOL_SEARCH_RESPONSE_BYTES);
    throwIfAborted(options.signal);
    return parseSymbolSearchResponse(bytes, canonical, manifest);
  }

  private stageDecodedGraph(
    candidate: LoadedGraphProjection,
    key: string,
    supersededReviewKey?: string,
  ): StagedGraphProjection {
    return this.stageAllocation(
      candidate,
      candidate.residentBytes,
      "graph projection",
      (current, options) => {
        const liveAlias = this.reviewSideAliases.get(key)?.reviewKey;
        const superseded = [supersededReviewKey, liveAlias]
          .filter((value): value is string => value !== undefined);
        this.cache.setActiveReplacing(
          key,
          { kind: "single", projection: current },
          current.residentBytes,
          [...superseded, ...(options.supersededKeys ?? [])],
        );
        this.pruneReviewSideAliases();
      },
    );
  }

  private stageDecodedReview(
    candidate: LoadedReviewProjection,
    headKey: string,
    mergeBaseKey: string,
  ): StagedReviewProjection {
    const metadataAlreadyOwned = this.reviewMetadata?.document.metadata.metadataId
      === candidate.reviewMetadata.metadataId;
    return this.stageAllocation(
      candidate,
      metadataAlreadyOwned
        ? candidate.residentBytes
        : safeByteSum(candidate.residentBytes, candidate.reviewMetadataResidentBytes),
      "graph review projection",
      (current, options) => {
        const outgoing = this.cache.active;
        const outgoingKey = this.cache.activeKey;
        const supersededOutgoing = outgoing?.kind === "review"
          && outgoing.projection.reviewMetadata.metadataId !== current.reviewMetadata.metadataId
          ? outgoingKey
          : undefined;
        this.cache.discardRecentWhere((_key, cached) => cached.kind === "review"
          && cached.projection.reviewMetadata.metadataId !== current.reviewMetadata.metadataId);
        const supersededReviews = [
          this.reviewSideAliases.get(headKey)?.reviewKey,
          this.reviewSideAliases.get(mergeBaseKey)?.reviewKey,
        ].filter((value): value is string => value !== undefined && value !== current.key);
        this.cache.setActiveReplacing(
          current.key,
          { kind: "review", projection: current },
          current.residentBytes,
          [
            headKey,
            mergeBaseKey,
            ...(supersededOutgoing === undefined ? [] : [supersededOutgoing]),
            ...supersededReviews,
            ...(options.supersededKeys ?? []),
          ],
        );
        this.rememberReviewSideAliases(current.key, headKey, mergeBaseKey);
        this.reviewMetadata = {
          key: reviewMetadataCacheKey(current.reviewMetadata),
          document: {
            metadata: current.reviewMetadata,
            serializedBytes: 0,
            residentBytes: current.reviewMetadataResidentBytes,
          },
        };
        this.pruneReviewSideAliases();
      },
    );
  }

  private stageAllocation<Projection>(
    candidate: Projection,
    residentBytes: number,
    label: string,
    install: (projection: Projection, options: ProjectionCommitOptions) => void,
  ): StagedProjection<Projection> {
    let projection: Projection | undefined = candidate;
    let committed = false;
    let allocationHandle: object | undefined;
    // Charge every pending owner, including a candidate which happens to be active right now. The
    // user can navigate before validation completes; without an independent reservation, eviction
    // of that formerly-active cache entry would leave this stage as an uncharged owner.
    allocationHandle = this.pendingBudget.register(residentBytes, () => {
      projection = undefined;
      allocationHandle = undefined;
    });
    if (allocationHandle === undefined) {
      projection = undefined;
      throw new Error(`${label} exceeds the bounded pending-projection budget`);
    }
    const read = (): Projection => {
      if (projection === undefined) {
        throw new Error(`staged ${label} was released or evicted`);
      }
      return projection;
    };
    return {
      get projection() { return read(); },
      commit: (options = {}) => {
        const current = read();
        if (committed) return current;
        // Release the pending charge first, then synchronously transfer the same object graph into
        // the active owner. JavaScript cannot interleave another admission between these operations.
        if (allocationHandle !== undefined) {
          this.pendingBudget.release(allocationHandle);
          allocationHandle = undefined;
        }
        try {
          install(current, options);
          committed = true;
          return current;
        } catch (error) {
          projection = undefined;
          throw error;
        }
      },
      release: () => {
        if (committed) return;
        if (allocationHandle !== undefined) {
          this.pendingBudget.release(allocationHandle);
          allocationHandle = undefined;
        }
        projection = undefined;
      },
    };
  }

  private peekReviewSideAlias(key: string): { projection: LoadedGraphProjection; reviewKey: string } | undefined {
    const alias = this.reviewSideAliases.get(key);
    if (alias === undefined) return undefined;
    const cached = this.cache.peek(alias.reviewKey);
    if (cached?.kind !== "review") {
      this.reviewSideAliases.delete(key);
      return undefined;
    }
    return {
      projection: alias.side === "head" ? cached.projection.head : cached.projection.mergeBase,
      reviewKey: alias.reviewKey,
    };
  }

  private async decodeWithAdmission<Projection>(
    request: GraphProjectionRequest,
    signal: AbortSignal,
    load: () => Promise<Projection>,
  ): Promise<TransferableDecodedProjection<Projection>> {
    const estimatedResidentBytes = estimatedDecodeLiability(
      request.maxResponseBytes,
      Math.max(this.residentExpansionFactor, DEFAULT_RESIDENT_EXPANSION_FACTOR)
        + TRANSIENT_RESPONSE_EXPANSION_FACTOR,
    );
    const release = await this.decodeAdmission.acquire(estimatedResidentBytes, signal);
    try {
      const projection = await load();
      this.decodedTransferOwners += 1;
      return new TransferableDecodedProjection(projection, () => {
        this.decodedTransferOwners -= 1;
        release();
      });
    } catch (error) {
      release();
      throw error;
    }
  }

  private rememberReviewSideAliases(reviewKey: string, headKey: string, mergeBaseKey: string): void {
    this.reviewSideAliases.set(headKey, { reviewKey, side: "head" });
    this.reviewSideAliases.set(mergeBaseKey, { reviewKey, side: "mergeBase" });
  }

  private pruneReviewSideAliases(): void {
    for (const [sideKey, alias] of this.reviewSideAliases) {
      if (this.cache.peek(alias.reviewKey)?.kind !== "review") this.reviewSideAliases.delete(sideKey);
    }
  }

  private subscribeProjection<T>(
    map: Map<string, SharedProjectionFlight<T>>,
    key: string,
    factory: (signal: AbortSignal) => Promise<T>,
    subscriberSignal?: AbortSignal,
    maxInFlight = MAX_IN_FLIGHT_PROJECTIONS,
    limitMessage = "too many graph projections are already in flight",
  ): Promise<T> {
    throwIfAborted(subscriberSignal);
    let flight = map.get(key);
    if (flight === undefined) {
      if (map.size >= maxInFlight) {
        throw new Error(limitMessage);
      }
      const controller = new AbortController();
      flight = {
        controller,
        subscribers: 0,
        settled: false,
        // Defer factory execution until after the flight is registered, preventing re-entrant
        // subscribers from racing a second transport into the same key.
        promise: Promise.resolve().then(() => factory(controller.signal)),
      };
      map.set(key, flight);
      const owned = flight;
      void owned.promise.then(
        () => settleProjectionFlight(map, key, owned),
        () => settleProjectionFlight(map, key, owned),
      );
    } else if (flight.controller.signal.aborted && !flight.settled) {
      // Keep the aborted flight as an admission-counted tombstone until its transport drains. New
      // subscribers then converge on one successor instead of inheriting the old cancellation or
      // creating an unbounded stack of physical reads for the same key.
      const drained = flight.promise.then(
        () => undefined,
        () => undefined,
      );
      return awaitWithSignal(
        drained.then(() => this.subscribeProjection(
          map,
          key,
          factory,
          subscriberSignal,
          maxInFlight,
          limitMessage,
        )),
        subscriberSignal,
      );
    }
    flight.subscribers += 1;
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      flight!.subscribers -= 1;
      if (flight!.subscribers === 0 && !flight!.settled && !flight!.controller.signal.aborted) {
        flight!.controller.abort(new DOMException("All projection subscribers left", "AbortError"));
      }
    };
    return awaitWithSignal(flight.promise, subscriberSignal).finally(release);
  }

  /**
   * Subscribe to a decoded physical flight and receive an explicit ownership lease. The flight's
   * root decode reservation remains charged until every live subscriber has synchronously retained
   * its own lease (or cancelled), after which consumers transfer that lease into pending ownership.
   */
  private subscribeDecodedProjection<T>(
    map: Map<string, SharedDecodedProjectionFlight<T>>,
    key: string,
    factory: (signal: AbortSignal) => Promise<TransferableDecodedProjection<T>>,
    subscriberSignal?: AbortSignal,
    maxInFlight = MAX_IN_FLIGHT_PROJECTIONS,
    limitMessage = "too many graph projections are already in flight",
  ): Promise<DecodedProjectionLease<T>> {
    throwIfAborted(subscriberSignal);
    let flight = map.get(key);
    if (flight === undefined) {
      if (map.size >= maxInFlight) throw new Error(limitMessage);
      const controller = new AbortController();
      flight = {
        controller,
        subscribers: 0,
        settled: false,
        rootReleased: false,
        promise: Promise.resolve().then(() => factory(controller.signal)),
      };
      map.set(key, flight);
      const owned = flight;
      void owned.promise.then(
        (root) => settleDecodedProjectionFlight(map, key, owned, root),
        () => settleDecodedProjectionFlight(map, key, owned),
      );
    } else if (flight.controller.signal.aborted && !flight.settled) {
      const drained = flight.promise.then(
        () => undefined,
        () => undefined,
      );
      return awaitWithSignal(
        drained.then(() => this.subscribeDecodedProjection(
          map,
          key,
          factory,
          subscriberSignal,
          maxInFlight,
          limitMessage,
        )),
        subscriberSignal,
      );
    }

    flight.subscribers += 1;
    const owned = flight;
    return new Promise<DecodedProjectionLease<T>>((resolve, reject) => {
      let delivered = false;
      const cleanup = () => {
        if (subscriberSignal !== undefined) subscriberSignal.removeEventListener("abort", abort);
      };
      const releaseSubscription = () => {
        owned.subscribers -= 1;
        if (owned.subscribers === 0 && !owned.settled && !owned.controller.signal.aborted) {
          owned.controller.abort(new DOMException("All projection subscribers left", "AbortError"));
        }
        releaseDecodedFlightRootIfUnused(owned);
      };
      const finish = (
        succeeded: boolean,
        value: DecodedProjectionLease<T> | unknown,
      ) => {
        if (delivered) return;
        delivered = true;
        cleanup();
        releaseSubscription();
        if (succeeded) resolve(value as DecodedProjectionLease<T>);
        else reject(value);
      };
      const abort = () => finish(
        false,
        subscriberSignal?.reason ?? new DOMException("Aborted", "AbortError"),
      );

      subscriberSignal?.addEventListener("abort", abort, { once: true });
      if (subscriberSignal?.aborted) {
        abort();
        return;
      }
      void owned.promise.then(
        (root) => {
          if (delivered) return;
          try {
            finish(true, root.retain());
          } catch (error) {
            finish(false, error);
          }
        },
        (error: unknown) => finish(false, error),
      );
    });
  }

  private async fetchProjection(
    manifest: GraphProjectionManifest,
    request: GraphProjectionRequest,
    endpoint: string,
    signal?: AbortSignal,
  ): Promise<LoadedGraphProjection> {
    const finishTransfer = startPerformanceSpan(PERFORMANCE.projectionTransfer);
    let response: Response;
    let payloadBytes: Uint8Array;
    try {
      response = await this.fetchImpl(endpoint, {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: canonicalGraphProjectionRequestJson(request),
        signal,
      });
      if (!response.ok) {
        await cancelUnreadResponse(response, "graph projection request failed");
        throw new Error(`graph projection fetch failed (${response.status}) from ${response.url || endpoint}`);
      }
      payloadBytes = await readBoundedResponse(
        response,
        request.maxResponseBytes,
      );
    } finally {
      finishTransfer();
    }
    throwIfAborted(signal);
    const finishParse = startPerformanceSpan(PERFORMANCE.projectionParse);
    let decoded: Awaited<ReturnType<typeof decodeProjectionResponse>>;
    try {
      decoded = await decodeProjectionResponse(payloadBytes, response.headers, request, manifest);
    } finally {
      finishParse();
    }
    throwIfAborted(signal);
    const residentBytes = conservativeResidentBytes(
      payloadBytes.byteLength,
      decoded.residentBytes,
      this.residentExpansionFactor,
    );
    const finishIndex = startPerformanceSpan(PERFORMANCE.projectionIndex);
    let index: GraphIndex;
    try {
      const structure: GraphStructureFacts = {
        hierarchyById: decoded.hierarchyById,
        moduleOverviewRootIds: decoded.moduleOverviewRootIds,
        moduleOverview: decoded.viewFacts.moduleOverview ?? EMPTY_MODULE_OVERVIEW,
        repositorySummary: manifest.repositorySummary,
      };
      index = buildGraphIndex(decoded.artifact, {
        structure,
        graphSummary: manifest.graphSummary,
        serviceTopology: decoded.viewFacts.service,
        artifactComplete: false,
      });
    } finally {
      finishIndex();
    }
    const key = canonicalProjectionKey(manifest.graphId, request);
    return {
      key,
      projectionId: decoded.projectionId,
      graphId: manifest.graphId,
      request,
      artifact: decoded.artifact,
      index,
      reachability: decoded.analysis.reachability,
      review: decoded.viewFacts.review,
      serializedBytes: payloadBytes.byteLength,
      residentBytes,
    };
  }
}

type CachedProjection =
  | { kind: "single"; projection: LoadedGraphProjection }
  | { kind: "review"; projection: LoadedReviewProjection };

interface ReviewSideAlias {
  reviewKey: string;
  side: "head" | "mergeBase";
}

interface LoadedReviewMetadataDocument {
  readonly metadata: GraphProjectionReviewMetadata;
  readonly serializedBytes: number;
  /** Settled parsed-object liability; transient response/decode bytes are admitted separately. */
  readonly residentBytes: number;
}

interface SharedProjectionFlight<T> {
  promise: Promise<T>;
  controller: AbortController;
  subscribers: number;
  settled: boolean;
}

interface DecodedProjectionLease<T> {
  readonly projection: T;
  release(): void;
}

/** One physical decoded allocation whose admission lease can be retained across aggregation and
 * transferred to each consumer without ever becoming temporarily uncharged. */
class TransferableDecodedProjection<T> {
  private owners = 1;
  private rootReleased = false;

  constructor(
    readonly projection: T,
    private readonly dispose: () => void,
  ) {}

  retain(): DecodedProjectionLease<T> {
    if (this.owners === 0) throw new Error("decoded projection ownership was already released");
    this.owners += 1;
    let released = false;
    return {
      projection: this.projection,
      release: () => {
        if (released) return;
        released = true;
        this.releaseOwner();
      },
    };
  }

  release(): void {
    if (this.rootReleased) return;
    this.rootReleased = true;
    this.releaseOwner();
  }

  private releaseOwner(): void {
    if (this.owners === 0) return;
    this.owners -= 1;
    if (this.owners === 0) this.dispose();
  }
}

interface SharedDecodedProjectionFlight<T> {
  promise: Promise<TransferableDecodedProjection<T>>;
  controller: AbortController;
  subscribers: number;
  settled: boolean;
  root?: TransferableDecodedProjection<T>;
  rootReleased: boolean;
}

interface PendingDecodeAdmission {
  residentBytes: number;
  signal: AbortSignal;
  resolve: (release: () => void) => void;
  reject: (reason: unknown) => void;
  onAbort: () => void;
}

/**
 * FIFO weighted admission for physical response decode/index work.
 *
 * Count bounds alone are not meaningful when every projection may carry a 16 MiB response. This
 * coordinator reserves the request's conservative decoded liability before network transfer and
 * transfers it after indexing through side/review aggregation until pending ownership is registered.
 * The fixed ceiling admits four default projections, so HEAD and merge-base still start together,
 * while queued/canceled subscribers own no response bytes.
 * A resolved candidate transfers first into the dedicated pending-stage budget. Only a committed
 * replacement can move the former active view into the independent 3-entry/48 MiB navigation LRU.
 */
class ProjectionDecodeAdmission {
  private residentBytes = 0;
  private readonly queue: PendingDecodeAdmission[] = [];

  constructor(private readonly maxResidentBytes: number) {}

  get residentByteLength(): number {
    return this.residentBytes;
  }

  get queuedCount(): number {
    return this.queue.length;
  }

  async acquire(residentBytes: number, signal: AbortSignal): Promise<() => void> {
    const bytes = nonNegativeSafeInteger(residentBytes, "decode residentBytes");
    if (bytes > this.maxResidentBytes) {
      throw new Error("graph projection decode exceeds the aggregate in-flight memory allowance");
    }
    throwIfAborted(signal);
    if (this.queue.length === 0 && this.residentBytes + bytes <= this.maxResidentBytes) {
      return this.reserve(bytes);
    }
    return new Promise<() => void>((resolve, reject) => {
      const pending: PendingDecodeAdmission = {
        residentBytes: bytes,
        signal,
        resolve,
        reject,
        onAbort: () => {
          const index = this.queue.indexOf(pending);
          if (index >= 0) this.queue.splice(index, 1);
          reject(signal.reason ?? new DOMException("Graph projection decode was aborted", "AbortError"));
          this.drain();
        },
      };
      signal.addEventListener("abort", pending.onAbort, { once: true });
      this.queue.push(pending);
      this.drain();
    });
  }

  private reserve(residentBytes: number): () => void {
    this.residentBytes += residentBytes;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.residentBytes -= residentBytes;
      this.drain();
    };
  }

  private drain(): void {
    while (this.queue.length > 0) {
      const pending = this.queue[0]!;
      if (pending.signal.aborted) {
        this.queue.shift();
        pending.signal.removeEventListener("abort", pending.onAbort);
        pending.reject(
          pending.signal.reason
            ?? new DOMException("Graph projection decode was aborted", "AbortError"),
        );
        continue;
      }
      if (this.residentBytes + pending.residentBytes > this.maxResidentBytes) return;
      this.queue.shift();
      pending.signal.removeEventListener("abort", pending.onAbort);
      pending.resolve(this.reserve(pending.residentBytes));
    }
  }
}

function estimatedDecodeLiability(maxResponseBytes: number, expansionFactor: number): number {
  const estimate = Math.ceil(maxResponseBytes * expansionFactor);
  if (!Number.isSafeInteger(estimate) || estimate < 0) {
    throw new RangeError("graph projection decode estimate exceeds safe integer range");
  }
  return estimate;
}

function settleProjectionFlight<T>(
  map: Map<string, SharedProjectionFlight<T>>,
  key: string,
  flight: SharedProjectionFlight<T>,
): void {
  flight.settled = true;
  if (map.get(key) === flight) map.delete(key);
}

function settleDecodedProjectionFlight<T>(
  map: Map<string, SharedDecodedProjectionFlight<T>>,
  key: string,
  flight: SharedDecodedProjectionFlight<T>,
  root?: TransferableDecodedProjection<T>,
): void {
  flight.root = root;
  flight.settled = true;
  if (map.get(key) === flight) map.delete(key);
  releaseDecodedFlightRootIfUnused(flight);
}

function releaseDecodedFlightRootIfUnused<T>(flight: SharedDecodedProjectionFlight<T>): void {
  if (!flight.settled || flight.subscribers > 0 || flight.rootReleased || flight.root === undefined) return;
  flight.rootReleased = true;
  flight.root.release();
}

export const OVERVIEW_PROJECTION_REQUEST: GraphProjectionRequest = {
  version: GRAPH_PROJECTION_PROTOCOL_VERSION,
  view: "modules",
  filePaths: [],
  reviewCursor: null,
  focusIds: [],
  expandedIds: [],
  extraIds: [],
  causalIds: [],
  serviceExpandedLeadIds: [],
  depth: 1,
  includeTests: false,
  includeReachability: false,
  maxNodes: DEFAULT_MAX_NODES,
  maxEdges: DEFAULT_MAX_EDGES,
  maxResponseBytes: DEFAULT_MAX_RESPONSE_BYTES,
};

/** Stable key shared by in-flight cancellation, the decoded-view LRU, and browser navigation. */
export function canonicalProjectionKey(graphId: string, request: GraphProjectionRequest): string {
  return `${graphId}\u0000${canonicalGraphProjectionRequestJson(canonicalizeProjectionRequest(request))}`;
}

/** A composite key makes HEAD+merge-base one navigation target and one byte-charged cache entry. */
export function canonicalReviewProjectionKey(headKey: string, mergeBaseKey: string): string {
  return `review-pair\u0000${JSON.stringify([headKey, mergeBaseKey])}`;
}

export function canonicalizeProjectionRequest(request: GraphProjectionRequest): GraphProjectionRequest {
  exactRecord(request, GRAPH_PROJECTION_REQUEST_FIELDS, "graph projection request", "v9");
  if (request.version !== GRAPH_PROJECTION_PROTOCOL_VERSION) {
    throw new TypeError(`graph projection request version must be ${GRAPH_PROJECTION_PROTOCOL_VERSION}`);
  }
  if (!isProjectionView(request.view)) {
    throw new TypeError(`unsupported graph projection view: ${String(request.view)}`);
  }
  if (!Number.isSafeInteger(request.depth) || request.depth < 0 || request.depth > 4) {
    throw new RangeError("graph projection depth must be an integer between 0 and 4");
  }
  if (typeof request.includeTests !== "boolean") {
    throw new TypeError("graph projection includeTests must be boolean");
  }
  if (typeof request.includeReachability !== "boolean") {
    throw new TypeError("graph projection includeReachability must be boolean");
  }
  const maxNodes = boundedInteger(request.maxNodes, 1, DEFAULT_MAX_NODES, "maxNodes");
  const maxEdges = boundedInteger(request.maxEdges, 0, DEFAULT_MAX_EDGES, "maxEdges");
  const maxResponseBytes = boundedInteger(
    request.maxResponseBytes,
    MIN_MAX_RESPONSE_BYTES,
    DEFAULT_MAX_RESPONSE_BYTES,
    "maxResponseBytes",
  );
  const filePaths = canonicalFilePaths(request.filePaths);
  const reviewCursor = canonicalReviewCursor(request.reviewCursor);
  if (request.view !== "review" && filePaths.length > 0) {
    throw new TypeError("graph projection filePaths are valid only for the review view");
  }
  if (request.view !== "review" && reviewCursor !== null) {
    throw new TypeError("graph projection reviewCursor is valid only for the review view");
  }
  if (filePaths.length > 0 && reviewCursor !== null) {
    throw new TypeError("graph projection reviewCursor cannot be combined with caller-owned filePaths");
  }
  const canonical: GraphProjectionRequest = {
    version: GRAPH_PROJECTION_PROTOCOL_VERSION,
    view: request.view,
    filePaths,
    reviewCursor,
    focusIds: canonicalIds(request.focusIds, MAX_FOCUS_IDS, "focusIds"),
    expandedIds: canonicalIds(request.expandedIds, MAX_EXPANDED_IDS, "expandedIds"),
    extraIds: canonicalIds(request.extraIds, MAX_EXTRA_IDS, "extraIds"),
    causalIds: canonicalIds(
      request.causalIds,
      MAX_CAUSAL_IDS,
      "causalIds",
      MAX_CAUSAL_IDS_BYTES,
    ),
    serviceExpandedLeadIds: canonicalIds(
      request.serviceExpandedLeadIds,
      MAX_EXPANDED_IDS,
      "serviceExpandedLeadIds",
    ),
    depth: request.depth,
    includeTests: request.includeTests,
    includeReachability: request.includeReachability,
    maxNodes,
    maxEdges,
    maxResponseBytes,
  };
  if (utf8Bytes(canonicalGraphProjectionRequestJson(canonical)) > GRAPH_PROJECTION_MAX_REQUEST_BYTES) {
    throw new RangeError(
      `graph projection request exceeds the ${GRAPH_PROJECTION_MAX_REQUEST_BYTES}-byte UTF-8 limit`,
    );
  }
  return canonical;
}

function canonicalReviewCursor(value: unknown): string | null {
  if (value === null) return null;
  if (!isGraphProjectionReviewCursor(value)) {
    throw new TypeError("graph projection reviewCursor is not a canonical comparison coordinate");
  }
  return value;
}

function canonicalIds(
  ids: readonly string[],
  limit: number,
  label: string,
  maxTotalBytes = Number.MAX_SAFE_INTEGER,
): string[] {
  if (!Array.isArray(ids) || ids.length > limit) {
    throw new RangeError(`graph projection ${label} exceeds its limit`);
  }
  const canonical = new Set<string>();
  let totalBytes = 0;
  for (const id of ids) {
    if (typeof id !== "string" || id.length === 0 || id.includes("\0") || utf8Bytes(id) > MAX_ID_BYTES) {
      throw new TypeError(`graph projection ${label} contains an invalid graph id`);
    }
    totalBytes += utf8Bytes(id);
    if (totalBytes > maxTotalBytes) {
      throw new RangeError(`graph projection ${label} exceeds its byte limit`);
    }
    canonical.add(id);
  }
  return [...canonical].sort();
}

function canonicalFilePaths(paths: readonly string[]): string[] {
  if (!Array.isArray(paths) || paths.length > MAX_FILE_PATHS) {
    throw new RangeError("graph projection filePaths exceeds its limit");
  }
  const canonical = new Set<string>();
  let totalBytes = 0;
  for (const path of paths) {
    if (typeof path !== "string" || path.length === 0) {
      throw new TypeError("graph projection filePaths contains a non-canonical file path");
    }
    const bytes = utf8Bytes(path);
    totalBytes += bytes;
    if (bytes > MAX_FILE_PATH_BYTES || totalBytes > MAX_FILE_PATHS_BYTES || path.startsWith("/")
      || /^[A-Za-z]:/.test(path) || path.includes("\\") || path.includes("\0")) {
      throw new TypeError(`invalid graph projection file path: ${path}`);
    }
    const segments = path.split("/");
    if (segments.some((segment) => segment.length === 0 || segment === "." || segment === "..")) {
      throw new TypeError(`invalid graph projection file path: ${path}`);
    }
    canonical.add(path);
  }
  return [...canonical].sort();
}

function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

async function fetchManifest(
  fetchImpl: typeof fetch,
  url: string,
  signal?: AbortSignal,
): Promise<GraphProjectionManifest> {
  const response = await fetchImpl(url, {
    credentials: "same-origin",
    headers: { accept: "application/json" },
    signal,
  });
  if (!response.ok) {
    await cancelUnreadResponse(response, "graph projection manifest request failed");
    throw new Error(`graph projection manifest fetch failed (${response.status}) from ${response.url || url}`);
  }
  const bytes = await readBoundedResponse(response, MAX_MANIFEST_RESPONSE_BYTES, "graph projection manifest");
  let raw: unknown;
  const text = decodeStrictUtf8(bytes, "graph projection manifest");
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error("invalid graph projection manifest: expected JSON");
  }
  return parseManifest(raw);
}

function reviewMetadataEndpoint(projectionUrl: string): string {
  const absolute = /^[a-z][a-z0-9+.-]*:/i.test(projectionUrl);
  const parsed = new URL(projectionUrl, "http://meridian.invalid");
  if (!parsed.pathname.endsWith("/projection") || parsed.hash !== "") {
    throw new TypeError("review projection endpoint cannot derive immutable metadata endpoint");
  }
  parsed.pathname = `${parsed.pathname.slice(0, -"projection".length)}review-metadata`;
  return absolute ? parsed.toString() : `${parsed.pathname}${parsed.search}`;
}

function reviewMetadataCacheKey(metadata: Pick<
  GraphProjectionReviewMetadata,
  "headGraphId" | "mergeBaseGraphId" | "headContentId" | "mergeBaseContentId"
>): string {
  return JSON.stringify([
    metadata.headGraphId,
    metadata.mergeBaseGraphId,
    metadata.headContentId,
    metadata.mergeBaseContentId,
  ]);
}

async function fetchReviewMetadata(
  fetchImpl: typeof fetch,
  endpoint: string,
  headManifest: GraphProjectionManifest,
  mergeBaseManifest: GraphProjectionManifest,
  headEndpoints: GraphProjectionEndpoints,
  mergeBaseEndpoints: GraphProjectionEndpoints,
  signal?: AbortSignal,
): Promise<LoadedReviewMetadataDocument> {
  const response = await fetchImpl(endpoint, {
    credentials: "same-origin",
    headers: { accept: "application/json" },
    signal,
  });
  if (!response.ok) {
    await cancelUnreadResponse(response, "graph review metadata request failed");
    throw new Error(`graph review metadata fetch failed (${response.status}) from ${response.url || endpoint}`);
  }
  const bytes = await readBoundedResponse(
    response,
    MAX_REVIEW_METADATA_RESPONSE_BYTES,
    "graph review metadata",
  );
  let raw: unknown;
  try {
    raw = JSON.parse(decodeStrictUtf8(bytes, "graph review metadata"));
  } catch {
    throw new Error("invalid graph review metadata: expected JSON");
  }
  const metadata = exactRecord(raw, [
    "version", "metadataId", "contextId", "headGraphId", "mergeBaseGraphId", "headContentId",
    "mergeBaseContentId", "totalFiles", "testClassifications",
  ], "graph review metadata", "v1");
  if (metadata.version !== 1
    || typeof metadata.metadataId !== "string" || !/^[0-9a-f]{64}$/.test(metadata.metadataId)
    || typeof metadata.contextId !== "string" || !/^[0-9a-f]{64}$/.test(metadata.contextId)
    || metadata.headGraphId !== headEndpoints.graphId
    || metadata.mergeBaseGraphId !== mergeBaseEndpoints.graphId
    || metadata.headContentId !== headManifest.contentId
    || metadata.mergeBaseContentId !== mergeBaseManifest.contentId) {
    throw new Error("invalid graph review metadata: immutable graph identity is inconsistent");
  }
  const totalFiles = boundedReviewInteger(metadata.totalFiles, 0, 100_000, "metadata.totalFiles");
  const testClassifications = parseReviewTestClassifications(metadata.testClassifications, totalFiles);
  const identity = {
    contextId: metadata.contextId,
    headGraphId: metadata.headGraphId as string,
    mergeBaseGraphId: metadata.mergeBaseGraphId as string,
    headContentId: metadata.headContentId as string,
    mergeBaseContentId: metadata.mergeBaseContentId as string,
  };
  const digest = await globalThis.crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(graphProjectionReviewMetadataIdentityPreimage(identity)),
  );
  const expectedId = Array.from(
    new Uint8Array(digest),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
  if (metadata.metadataId !== expectedId) {
    throw new Error("invalid graph review metadata: metadata identity does not match its capabilities");
  }
  const metadataValue: GraphProjectionReviewMetadata = Object.freeze({
    version: 1,
    metadataId: metadata.metadataId,
    ...identity,
    totalFiles,
    testClassifications: Object.freeze(testClassifications),
  });
  return Object.freeze({
    metadata: metadataValue,
    serializedBytes: bytes.byteLength,
    residentBytes: conservativeResidentBytes(
      bytes.byteLength,
      bytes.byteLength * DEFAULT_RESIDENT_EXPANSION_FACTOR,
      DEFAULT_RESIDENT_EXPANSION_FACTOR,
    ),
  });
}

function parseManifest(raw: unknown): GraphProjectionManifest {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error("invalid graph projection manifest: expected an object");
  }
  if ((raw as Record<string, unknown>).version !== GRAPH_PROJECTION_PROTOCOL_VERSION) {
    throw new Error(`invalid graph projection manifest: expected version ${GRAPH_PROJECTION_PROTOCOL_VERSION}`);
  }
  const candidate = exactRecord(raw, PROJECTION_MANIFEST_FIELDS, "graph projection manifest", "v9");
  if (typeof candidate.graphId !== "string" || candidate.graphId.length === 0) {
    throw new Error("invalid graph projection manifest: graphId is required");
  }
  if (typeof candidate.contentId !== "string" || !/^[0-9a-f]{64}$/.test(candidate.contentId)) {
    throw new Error("invalid graph projection manifest: contentId must be a 64-character hex digest");
  }
  const summary = exactRecord(candidate.graphSummary, [
    "schemaVersion",
    "generatedAt",
    "nodeCount",
    "edgeCount",
  ], "graph projection manifest graphSummary", "v9");
  if (typeof summary.schemaVersion !== "string" || summary.schemaVersion.length === 0
    || typeof summary.generatedAt !== "string" || summary.generatedAt.length === 0
    || !Number.isSafeInteger(summary.nodeCount) || Number(summary.nodeCount) < 0
    || !Number.isSafeInteger(summary.edgeCount) || Number(summary.edgeCount) < 0) {
    throw new Error("invalid graph projection manifest: graphSummary is malformed");
  }
  const repositorySummary = parseRepositorySummary(candidate.repositorySummary);
  return {
    version: GRAPH_PROJECTION_PROTOCOL_VERSION,
    graphId: candidate.graphId,
    contentId: candidate.contentId,
    graphSummary: {
      schemaVersion: summary.schemaVersion,
      generatedAt: summary.generatedAt,
      nodeCount: Number(summary.nodeCount),
      edgeCount: Number(summary.edgeCount),
    },
    repositorySummary,
    defaultView: parseManifestDefaultView(candidate.defaultView),
  };
}

function assertExpectedManifestGraph(
  manifest: GraphProjectionManifest,
  expectedGraphId: string,
): void {
  if (typeof expectedGraphId !== "string" || expectedGraphId.length === 0) {
    throw new TypeError("graph projection capability graphId is required");
  }
  if (manifest.graphId !== expectedGraphId) {
    throw new Error(
      `graph projection manifest identity mismatch: expected '${expectedGraphId}', received '${manifest.graphId}'`,
    );
  }
}

function parseRepositorySummary(value: unknown): GraphRepositorySummary {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("invalid graph projection manifest: repositorySummary is required");
  }
  const summary = value as Record<string, unknown>;
  if (Object.keys(summary).sort().join("\0")
      !== "overviewPackageCount\0sourceFileCount\0testSourceFileCount"
    || !Number.isSafeInteger(summary.overviewPackageCount) || Number(summary.overviewPackageCount) < 0
    || !Number.isSafeInteger(summary.sourceFileCount) || Number(summary.sourceFileCount) < 0
    || !Number.isSafeInteger(summary.testSourceFileCount) || Number(summary.testSourceFileCount) < 0
    || Number(summary.testSourceFileCount) > Number(summary.sourceFileCount)) {
    throw new Error("invalid graph projection manifest: repositorySummary is malformed");
  }
  return {
    overviewPackageCount: Number(summary.overviewPackageCount),
    sourceFileCount: Number(summary.sourceFileCount),
    testSourceFileCount: Number(summary.testSourceFileCount),
  };
}

function parseManifestDefaultView(raw: unknown): GraphProjectionRequest {
  const candidate = exactRecord(
    raw,
    GRAPH_PROJECTION_REQUEST_FIELDS,
    "graph projection manifest defaultView",
    "v9",
  );
  return canonicalizeProjectionRequest({
    version: candidate.version as typeof GRAPH_PROJECTION_PROTOCOL_VERSION,
    view: candidate.view as GraphProjectionView,
    filePaths: manifestStringArray(candidate.filePaths, "filePaths"),
    reviewCursor: candidate.reviewCursor as string | null,
    focusIds: manifestStringArray(candidate.focusIds, "focusIds"),
    expandedIds: manifestStringArray(candidate.expandedIds, "expandedIds"),
    extraIds: manifestStringArray(candidate.extraIds, "extraIds"),
    causalIds: manifestStringArray(candidate.causalIds, "causalIds"),
    serviceExpandedLeadIds: manifestStringArray(candidate.serviceExpandedLeadIds, "serviceExpandedLeadIds"),
    depth: candidate.depth as number,
    includeTests: candidate.includeTests as boolean,
    includeReachability: candidate.includeReachability as boolean,
    maxNodes: candidate.maxNodes as number,
    maxEdges: candidate.maxEdges as number,
    maxResponseBytes: candidate.maxResponseBytes as number,
  });
}

function parseReturnedProjectionRequest(raw: unknown): GraphProjectionRequest {
  const candidate = exactRecord(
    raw,
    GRAPH_PROJECTION_REQUEST_FIELDS,
    "graph projection response request",
    "v9",
  );
  return canonicalizeProjectionRequest({
    version: candidate.version as typeof GRAPH_PROJECTION_PROTOCOL_VERSION,
    view: candidate.view as GraphProjectionView,
    filePaths: manifestStringArray(candidate.filePaths, "filePaths"),
    reviewCursor: candidate.reviewCursor as string | null,
    focusIds: manifestStringArray(candidate.focusIds, "focusIds"),
    expandedIds: manifestStringArray(candidate.expandedIds, "expandedIds"),
    extraIds: manifestStringArray(candidate.extraIds, "extraIds"),
    causalIds: manifestStringArray(candidate.causalIds, "causalIds"),
    serviceExpandedLeadIds: manifestStringArray(candidate.serviceExpandedLeadIds, "serviceExpandedLeadIds"),
    depth: candidate.depth as number,
    includeTests: candidate.includeTests as boolean,
    includeReachability: candidate.includeReachability as boolean,
    maxNodes: candidate.maxNodes as number,
    maxEdges: candidate.maxEdges as number,
    maxResponseBytes: candidate.maxResponseBytes as number,
  });
}

function manifestStringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error(`invalid graph projection request in manifest: ${label}`);
  }
  return value as string[];
}

function canonicalizeSymbolSearchRequest(request: GraphSymbolSearchRequest): GraphSymbolSearchRequest {
  const canonical = exactRecord(
    request,
    ["version", "query", "mode", "scope"],
    "graph symbol search request",
  );
  if (canonical.version !== GRAPH_SYMBOL_SEARCH_VERSION) {
    throw new TypeError(`graph symbol search requires version ${GRAPH_SYMBOL_SEARCH_VERSION}`);
  }
  if (typeof canonical.query !== "string" || canonical.query.includes("\0")
    || utf8Bytes(canonical.query) > MAX_SYMBOL_SEARCH_QUERY_BYTES) {
    throw new RangeError(`graph symbol search query exceeds ${MAX_SYMBOL_SEARCH_QUERY_BYTES} UTF-8 bytes`);
  }
  if (canonical.mode !== "map" && canonical.mode !== "logic") {
    throw new TypeError("graph symbol search mode is invalid");
  }
  if (canonical.scope !== "public" && canonical.scope !== "all" && canonical.scope !== "private") {
    throw new TypeError("graph symbol search scope is invalid");
  }
  return {
    version: GRAPH_SYMBOL_SEARCH_VERSION,
    query: canonical.query,
    mode: canonical.mode,
    scope: canonical.scope,
  };
}

function parseSymbolSearchResponse(
  bytes: Uint8Array,
  expected: GraphSymbolSearchRequest,
  manifest: GraphProjectionManifest,
): GraphSymbolSearchResult {
  let raw: unknown;
  const text = decodeStrictUtf8(bytes, "graph symbol search response");
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error("invalid graph symbol search response: expected JSON");
  }
  const record = exactRecord(raw, [
    "version",
    "graphId",
    "contentId",
    "mode",
    "scope",
    "scopeCounts",
    "results",
  ], "graph symbol search response");
  if (record.version !== GRAPH_SYMBOL_SEARCH_VERSION
    || record.graphId !== manifest.graphId
    || record.contentId !== manifest.contentId
    || record.mode !== expected.mode
    || record.scope !== expected.scope) {
    throw new Error("invalid graph symbol search response: identity does not match the active manifest");
  }
  const counts = exactRecord(record.scopeCounts, ["public", "all", "private"], "graph symbol scope counts");
  const scopeCounts = {
    public: nonNegativeSafeInteger(counts.public, "scopeCounts.public"),
    all: nonNegativeSafeInteger(counts.all, "scopeCounts.all"),
    private: nonNegativeSafeInteger(counts.private, "scopeCounts.private"),
  };
  if (scopeCounts.all !== scopeCounts.public + scopeCounts.private) {
    throw new Error("invalid graph symbol search response: scope counts do not partition all symbols");
  }
  if (!Array.isArray(record.results) || record.results.length > MAX_GRAPH_SYMBOL_RESULTS) {
    throw new Error(`invalid graph symbol search response: results exceed ${MAX_GRAPH_SYMBOL_RESULTS}`);
  }
  const seen = new Set<string>();
  const results = record.results.map((value, index) => {
    const entry = parseSymbolEntry(value, index, expected);
    if (seen.has(entry.id)) throw new Error("invalid graph symbol search response: duplicate result id");
    seen.add(entry.id);
    return entry;
  });
  return {
    version: GRAPH_SYMBOL_SEARCH_VERSION,
    graphId: manifest.graphId,
    contentId: manifest.contentId,
    mode: expected.mode,
    scope: expected.scope,
    scopeCounts,
    results,
  };
}

function parseSymbolEntry(
  value: unknown,
  index: number,
  request: GraphSymbolSearchRequest,
): GraphSymbolEntry {
  const record = exactRecord(value, [
    "id",
    "displayName",
    "qualifiedName",
    "file",
    "kind",
    "isPrivateMethod",
    "stepCount",
  ], `graph symbol result ${index}`);
  const id = boundedString(record.id, MAX_ID_BYTES, `results[${index}].id`, false);
  const displayName = boundedString(record.displayName, MAX_ID_BYTES, `results[${index}].displayName`, false);
  const qualifiedName = boundedString(record.qualifiedName, MAX_ID_BYTES, `results[${index}].qualifiedName`, true);
  const file = boundedString(record.file, 4_096, `results[${index}].file`, true);
  const kind = boundedString(record.kind, 64, `results[${index}].kind`, false);
  const mapKinds = new Set(["function", "method", "module", "package", "class", "interface", "object"]);
  const logicKinds = new Set(["function", "method", "module"]);
  if (!(request.mode === "map" ? mapKinds : logicKinds).has(kind)) {
    throw new Error(`invalid graph symbol search response: results[${index}].kind is not searchable`);
  }
  if (typeof record.isPrivateMethod !== "boolean") {
    throw new Error(`invalid graph symbol search response: results[${index}].isPrivateMethod is invalid`);
  }
  const isPrivateMethod = record.isPrivateMethod;
  if (isPrivateMethod !== (kind === "method" && displayName.startsWith("__"))) {
    throw new Error(`invalid graph symbol search response: results[${index}] private classification is inconsistent`);
  }
  if ((request.scope === "public" && isPrivateMethod) || (request.scope === "private" && !isPrivateMethod)) {
    throw new Error(`invalid graph symbol search response: results[${index}] violates the requested scope`);
  }
  const stepCount = record.stepCount === null
    ? null
    : nonNegativeSafeInteger(record.stepCount, `results[${index}].stepCount`);
  return { id, displayName, qualifiedName, file, kind, isPrivateMethod, stepCount };
}

function exactRecord(
  value: unknown,
  keys: readonly string[],
  label: string,
  contract = "v1",
): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`invalid ${label}: expected an object`);
  }
  const record = value as Record<string, unknown>;
  const actual = Object.keys(record).sort();
  const expected = [...keys].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`invalid ${label}: fields do not match the ${contract} contract`);
  }
  return record;
}

function nonNegativeSafeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw new Error(`invalid graph symbol search response: ${label} is invalid`);
  }
  return Number(value);
}

function boundedString(value: unknown, maxBytes: number, label: string, allowEmpty: boolean): string {
  if (typeof value !== "string" || (!allowEmpty && value.length === 0)
    || value.includes("\0") || utf8Bytes(value) > maxBytes) {
    throw new Error(`invalid graph symbol search response: ${label} is invalid`);
  }
  return value;
}

async function decodeProjectionResponse(
  bytes: Uint8Array,
  headers: Headers,
  expectedRequest: GraphProjectionRequest,
  manifest: GraphProjectionManifest,
): Promise<{
  projectionId: string;
  artifact: GraphArtifact;
  residentBytes: number;
  hierarchyById: ReadonlyMap<string, GraphHierarchyFact>;
  moduleOverviewRootIds: readonly string[];
  viewFacts: {
    moduleOverview: GraphModuleOverview | null;
    service: SerializedServiceTopologyV1 | null;
    review: GraphProjectionReviewFacts | null;
  };
  analysis: { reachability: ReachabilityProjectionFacts | null };
}> {
  let raw: unknown;
  const text = decodeStrictUtf8(bytes, "graph projection response");
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error("invalid graph projection response: expected JSON");
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error("invalid graph projection response: expected an object");
  }
  const record = raw as Record<string, unknown>;
  const expectedFields = [...PROJECTION_RESPONSE_FIELDS].sort();
  if (JSON.stringify(Object.keys(record).sort()) !== JSON.stringify(expectedFields)) {
    throw new Error("invalid graph projection response: fields do not match the v9 contract");
  }
  if (record.version !== GRAPH_PROJECTION_PROTOCOL_VERSION) {
    throw new Error(`invalid graph projection response: expected version ${GRAPH_PROJECTION_PROTOCOL_VERSION}`);
  }
  if (record.contentId !== manifest.contentId) {
    throw new Error("invalid graph projection response: content identity does not match its manifest");
  }
  if (!isGraphArtifact(record.artifact)) {
    throw new Error("invalid graph projection response: artifact is required");
  }
  const returnedRequest = parseReturnedProjectionRequest(record.request);
  if (JSON.stringify(returnedRequest) !== JSON.stringify(expectedRequest)) {
    throw new Error("invalid graph projection response: request identity does not match");
  }
  assertCompleteProjection(record.completeness);
  const artifact = record.artifact as unknown as GraphArtifact;
  assertSupportedSchema(artifact.schemaVersion);
  if (artifact.schemaVersion !== manifest.graphSummary.schemaVersion
    || artifact.generatedAt !== manifest.graphSummary.generatedAt
    || artifact.nodes.length > manifest.graphSummary.nodeCount
    || artifact.edges.length > manifest.graphSummary.edgeCount) {
    throw new Error("invalid graph projection response: artifact revision does not match its manifest");
  }
  if (typeof record.projectionId !== "string" || !/^[0-9a-f]{64}$/.test(record.projectionId)) {
    throw new Error("invalid graph projection response: projectionId must be a SHA-256 digest");
  }
  if (!Number.isSafeInteger(record.residentBytes) || Number(record.residentBytes) < 0) {
    throw new Error("invalid graph projection response: residentBytes is malformed");
  }
  const headerProjectionId = headers.get("x-meridian-projection-id");
  if (headerProjectionId === null || headerProjectionId !== record.projectionId) {
    throw new Error("invalid graph projection response: projection identity header does not match the body");
  }
  const expectedProjectionId = await deriveProjectionId(manifest.contentId, returnedRequest);
  if (record.projectionId !== expectedProjectionId) {
    throw new Error("invalid graph projection response: projection identity does not match its v9 content and request");
  }
  const headerResidentBytes = headers.get("x-meridian-resident-bytes");
  if (headerResidentBytes === null
    || !/^\d+$/.test(headerResidentBytes)
    || !Number.isSafeInteger(Number(headerResidentBytes))
    || Number(headerResidentBytes) !== record.residentBytes) {
    throw new Error("invalid graph projection response: resident byte header does not match the body");
  }
  const viewFacts = parseProjectionViewFacts(record.viewFacts, expectedRequest);
  const analysis = parseProjectionAnalysis(record.analysis, expectedRequest, artifact);
  const hierarchy = parseProjectionHierarchy(
    record.hierarchy,
    artifact,
    expectedRequest,
    viewFacts.moduleOverview,
  );
  assertReviewGraphMatch(viewFacts.review, artifact, hierarchy.hierarchyById);
  return {
    artifact,
    projectionId: record.projectionId,
    residentBytes: Number(record.residentBytes),
    hierarchyById: hierarchy.hierarchyById,
    moduleOverviewRootIds: hierarchy.moduleOverviewRootIds,
    viewFacts,
    analysis,
  };
}

function assertReviewGraphMatch(
  review: GraphProjectionReviewFacts | null,
  artifact: GraphArtifact,
  hierarchyById: ReadonlyMap<string, GraphHierarchyFact>,
): void {
  if (review === null) return;
  const residentFiles = new Set<string>();
  for (const node of artifact.nodes) {
    const file = node.location?.file;
    if (typeof file === "string") residentFiles.add(file.replace(/\\/g, "/"));
  }
  const selection = review.selection;
  if (selection !== null) {
    const matched = selection.graphPath !== null && residentFiles.has(selection.graphPath);
    if (selection.graphMatched !== matched) {
      throw new Error("invalid graph projection response: review graphMatched contradicts the decoded artifact");
    }
    if (matched && selection.isTest !== null) {
      const representative = reviewRepresentativeForPath(artifact.nodes, selection.graphPath!);
      if (representative === undefined
        || hierarchyById.get(representative.id)?.isTest !== selection.isTest) {
        throw new Error("invalid graph projection response: review selection test verdict contradicts its hierarchy");
      }
    }
  }
  const overview = review.overview;
  if (overview === null) return;
  const pageEntries = review.page?.entries ?? [];
  for (let offset = 0; offset < overview.entries.length; offset += 1) {
    const coverage = overview.entries[offset]!;
    const entry = pageEntries[offset]!;
    const graphPath = reviewGraphPathForSide(entry, review.side);
    const graphMatched = graphPath !== null && residentFiles.has(graphPath);
    if (graphPath === null) {
      if (coverage.state !== "absent") {
        throw new Error("invalid graph projection response: review overview absent-side coverage is inconsistent");
      }
    } else if (coverage.state === "absent") {
      throw new Error("invalid graph projection response: review overview marks a present graph path absent");
    }
    if ((coverage.state === "included") !== graphMatched) {
      throw new Error("invalid graph projection response: review overview coverage contradicts the decoded artifact");
    }
    if (coverage.state === "included" && coverage.isTest !== null) {
      const representative = reviewRepresentativeForPath(artifact.nodes, graphPath!);
      if (representative === undefined
        || hierarchyById.get(representative.id)?.isTest !== coverage.isTest) {
        throw new Error("invalid graph projection response: review overview test verdict contradicts its hierarchy");
      }
    }
  }
}

function assertReviewMetadataMatchesProjections(
  metadata: GraphProjectionReviewMetadata,
  head: LoadedGraphProjection,
  mergeBase: LoadedGraphProjection,
): void {
  const headFacts = head.review;
  const mergeBaseFacts = mergeBase.review;
  if (headFacts === null || mergeBaseFacts === null
    || headFacts.side !== "head" || mergeBaseFacts.side !== "mergeBase"
    || headFacts.contextId !== metadata.contextId || mergeBaseFacts.contextId !== metadata.contextId
    || headFacts.metadataId !== metadata.metadataId || mergeBaseFacts.metadataId !== metadata.metadataId
    || headFacts.totalFiles !== metadata.totalFiles || mergeBaseFacts.totalFiles !== metadata.totalFiles
    || head.graphId !== metadata.headGraphId || mergeBase.graphId !== metadata.mergeBaseGraphId) {
    throw new Error("graph review coordinate does not match its immutable metadata document");
  }
  const catalog = new Map(
    metadata.testClassifications.map((entry) => [entry.index, entry.isTest] as const),
  );
  const headVerdicts = coordinateReviewVerdicts(headFacts);
  const mergeBaseVerdicts = coordinateReviewVerdicts(mergeBaseFacts);
  const indexes = new Set([...headVerdicts.keys(), ...mergeBaseVerdicts.keys()]);
  for (const index of indexes) {
    const expected = headVerdicts.get(index) ?? mergeBaseVerdicts.get(index) ?? null;
    if ((catalog.get(index) ?? null) !== expected) {
      throw new Error("graph review coordinate classification contradicts its immutable metadata document");
    }
  }
}

function coordinateReviewVerdicts(facts: GraphProjectionReviewFacts): ReadonlyMap<number, boolean | null> {
  const verdicts = new Map<number, boolean | null>();
  if (facts.selection !== null) verdicts.set(facts.selection.index, facts.selection.isTest);
  for (const entry of facts.overview?.entries ?? []) verdicts.set(entry.index, entry.isTest);
  return verdicts;
}

function reviewRepresentativeForPath(
  nodes: ReadonlyArray<GraphArtifact["nodes"][number]>,
  graphPath: string,
): GraphArtifact["nodes"][number] | undefined {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const rank = (node: GraphArtifact["nodes"][number]): number => {
    if (node.kind === "module") return 0;
    const parentPath = byId.get(node.parentId ?? "")?.location?.file.replace(/\\/g, "/");
    return parentPath === graphPath ? 2 : 1;
  };
  return nodes
    .filter((node) => node.location?.file.replace(/\\/g, "/") === graphPath)
    .sort((left, right) => rank(left) - rank(right)
      || compareCanonicalPrPreparePaths(left.id, right.id))[0];
}

async function deriveProjectionId(
  contentId: string,
  request: GraphProjectionRequest,
): Promise<string> {
  const input = new TextEncoder().encode(
    graphProjectionIdentityPreimage(contentId, request),
  );
  const digest = await globalThis.crypto.subtle.digest("SHA-256", input);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function parseProjectionViewFacts(
  value: unknown,
  request: GraphProjectionRequest,
): {
  moduleOverview: GraphModuleOverview | null;
  service: SerializedServiceTopologyV1 | null;
  review: GraphProjectionReviewFacts | null;
} {
  const facts = exactRecord(
    value,
    PROJECTION_VIEW_FACT_FIELDS,
    "graph projection response viewFacts",
    "v9",
  );
  const expectsModuleOverview = request.focusIds.length === 0
    && (request.view === "modules" || request.view === "ui");
  let moduleOverview: GraphModuleOverview | null = null;
  if (facts.moduleOverview !== null) {
    try {
      moduleOverview = parseGraphModuleOverview(facts.moduleOverview);
    } catch (error) {
      throw new Error("invalid graph projection response: moduleOverview is malformed", { cause: error });
    }
  }
  if ((moduleOverview !== null) !== expectsModuleOverview) {
    throw new Error("invalid graph projection response: moduleOverview does not match the requested view");
  }

  let service: SerializedServiceTopologyV1 | null = null;
  if (facts.service !== null) {
    try {
      service = parseSerializedServiceTopology(facts.service);
    } catch (error) {
      throw new Error("invalid graph projection response: service topology is malformed", { cause: error });
    }
  }
  if ((service !== null) !== (request.view === "service")) {
    throw new Error("invalid graph projection response: service topology does not match the requested view");
  }
  const review = parseProjectionReviewFacts(facts.review, request);
  return { moduleOverview, service, review };
}

function parseProjectionReviewFacts(
  value: unknown,
  request: GraphProjectionRequest,
): GraphProjectionReviewFacts | null {
  if (value === null) {
    if (request.reviewCursor !== null) {
      throw new Error("invalid graph projection response: review facts are required for a comparison coordinate");
    }
    return null;
  }
  if (request.view !== "review" || request.filePaths.length > 0) {
    throw new Error("invalid graph projection response: review facts require a context-bound review request");
  }
  const facts = exactRecord(value, [
    "contextId", "metadataId", "side", "totalFiles", "statusCounts", "pageCount", "page",
    "selection", "overview",
  ], "graph projection response review facts", "v9");
  if (typeof facts.contextId !== "string" || !/^[0-9a-f]{64}$/.test(facts.contextId)) {
    throw new Error("invalid graph projection response: review contextId is malformed");
  }
  if (typeof facts.metadataId !== "string" || !/^[0-9a-f]{64}$/.test(facts.metadataId)) {
    throw new Error("invalid graph projection response: review metadataId is malformed");
  }
  if (facts.side !== "head" && facts.side !== "mergeBase") {
    throw new Error("invalid graph projection response: review side is malformed");
  }
  const totalFiles = boundedReviewInteger(facts.totalFiles, 0, 100_000, "totalFiles");
  const pageCount = boundedReviewInteger(facts.pageCount, 0, 100_000, "pageCount");
  const statusCounts = parseReviewStatusCounts(facts.statusCounts, "statusCounts");
  if (sumReviewStatusCounts(statusCounts) !== totalFiles
    || (totalFiles === 0 ? pageCount !== 0 : pageCount < 1 || pageCount > totalFiles)) {
    throw new Error("invalid graph projection response: review rollup totals are inconsistent");
  }
  const page = facts.page === null
    ? null
    : parseReviewPage(facts.page, totalFiles, pageCount);
  const selection = facts.selection === null
    ? null
    : parseReviewSelection(facts.selection, totalFiles, facts.side);
  const overview = facts.overview === null
    ? null
    : parseReviewOverview(facts.overview, page, request.includeTests);
  if (totalFiles === 0 && selection !== null) {
    throw new Error("invalid graph projection response: an empty review cannot select a file");
  }
  if (page !== null && selection !== null) {
    throw new Error("invalid graph projection response: review facts cannot contain a page and selection together");
  }
  const expectsOverview = request.reviewCursor === null || request.reviewCursor.startsWith("page:");
  if ((overview !== null) !== expectsOverview) {
    throw new Error("invalid graph projection response: review overview coverage does not match its coordinate");
  }
  if (request.reviewCursor === null) {
    if (selection !== null || (totalFiles === 0 ? page !== null : page?.index !== 0)) {
      throw new Error("invalid graph projection response: review overview facts do not match their coordinate");
    }
  } else {
    const separator = request.reviewCursor.indexOf(":");
    const kind = request.reviewCursor.slice(0, separator);
    const index = Number(request.reviewCursor.slice(separator + 1));
    if (kind === "page") {
      if (selection !== null || page?.index !== index) {
        throw new Error("invalid graph projection response: review page does not match its coordinate");
      }
    } else if (page !== null || selection?.index !== index) {
      throw new Error("invalid graph projection response: review selection does not match its coordinate");
    }
  }
  return {
    contextId: facts.contextId,
    metadataId: facts.metadataId,
    side: facts.side,
    totalFiles,
    statusCounts,
    pageCount,
    page,
    selection,
    overview,
  };
}

function parseReviewOverview(
  value: unknown,
  page: GraphProjectionReviewFacts["page"],
  includeTests: boolean,
): NonNullable<GraphProjectionReviewFacts["overview"]> {
  const overview = exactRecord(
    value,
    ["entries"],
    "graph projection response review overview",
    "v9",
  );
  if (!Array.isArray(overview.entries)) {
    throw new Error("invalid graph projection response: review overview entries are malformed");
  }
  const pageEntries = page?.entries ?? [];
  if (overview.entries.length !== pageEntries.length) {
    throw new Error("invalid graph projection response: review overview coverage is incomplete");
  }
  const entries = overview.entries.map((value, offset) => {
    const coverage = exactRecord(
      value,
      ["index", "state", "isTest"],
      "graph projection response review overview entry",
      "v9",
    );
    if (coverage.index !== pageEntries[offset]!.index) {
      throw new Error("invalid graph projection response: review overview coverage is not in page order");
    }
    if (coverage.state !== "included"
      && coverage.state !== "unmapped"
      && coverage.state !== "filtered"
      && coverage.state !== "deferred"
      && coverage.state !== "absent") {
      throw new Error("invalid graph projection response: review overview coverage state is malformed");
    }
    if (coverage.isTest !== null && typeof coverage.isTest !== "boolean") {
      throw new Error("invalid graph projection response: review overview test verdict is malformed");
    }
    const graphBacked = coverage.state === "included"
      || coverage.state === "filtered"
      || coverage.state === "deferred";
    if (graphBacked === (coverage.isTest === null)) {
      throw new Error("invalid graph projection response: review overview test verdict has no graph evidence");
    }
    if ((coverage.state === "filtered") !== (!includeTests && coverage.isTest === true)) {
      throw new Error("invalid graph projection response: review overview test filtering is inconsistent");
    }
    return {
      index: pageEntries[offset]!.index,
      state: coverage.state as NonNullable<GraphProjectionReviewFacts["overview"]>["entries"][number]["state"],
      isTest: coverage.isTest,
    };
  });
  return { entries };
}

function parseReviewTestClassifications(
  value: unknown,
  totalFiles: number,
): GraphProjectionReviewMetadata["testClassifications"] {
  if (!Array.isArray(value) || value.length > totalFiles) {
    throw new Error("invalid graph projection response: review test classifications are malformed");
  }
  let previousIndex = -1;
  return value.map((entry) => {
    const classification = exactRecord(
      entry,
      ["index", "isTest"],
      "graph projection response review test classification",
      "v9",
    );
    const index = boundedReviewInteger(
      classification.index,
      0,
      Math.max(0, totalFiles - 1),
      "testClassifications.index",
    );
    if (index <= previousIndex) {
      throw new Error("invalid graph projection response: review test classifications are not canonical");
    }
    if (typeof classification.isTest !== "boolean") {
      throw new Error("invalid graph projection response: review test classification verdict is malformed");
    }
    previousIndex = index;
    return { index, isTest: classification.isTest };
  });
}

function parseReviewPage(
  value: unknown,
  totalFiles: number,
  pageCount: number,
): NonNullable<GraphProjectionReviewFacts["page"]> {
  const page = exactRecord(value, [
    "index", "entries", "statusCounts", "previousCursor", "nextCursor",
  ], "graph projection response review page", "v9");
  const index = boundedReviewInteger(page.index, 0, Math.max(0, pageCount - 1), "page.index");
  if (!Array.isArray(page.entries) || page.entries.length === 0 || page.entries.length > 64) {
    throw new Error("invalid graph projection response: review page entries are malformed");
  }
  const entries = page.entries.map((entry) => parseReviewFile(entry, totalFiles));
  for (let offset = 1; offset < entries.length; offset += 1) {
    if (entries[offset]!.index !== entries[offset - 1]!.index + 1
      || compareCanonicalPrPreparePaths(entries[offset - 1]!.path, entries[offset]!.path) >= 0) {
      throw new Error("invalid graph projection response: review page entries are not canonical and contiguous");
    }
  }
  const pathBytes = entries.reduce(
    (bytes, entry) => bytes + utf8Bytes(entry.path)
      + (entry.status === "renamed" ? utf8Bytes(entry.previousPath!) : 0),
    0,
  );
  if (pathBytes > 24 * 1024) {
    throw new Error("invalid graph projection response: review page exceeds its path-byte bound");
  }
  const statusCounts = parseReviewStatusCounts(page.statusCounts, "page.statusCounts");
  const actualCounts: Record<keyof GraphProjectionReviewStatusCounts, number> = {
    added: 0,
    modified: 0,
    deleted: 0,
    renamed: 0,
  };
  for (const entry of entries) actualCounts[entry.status] += 1;
  if (JSON.stringify(statusCounts) !== JSON.stringify(actualCounts)) {
    throw new Error("invalid graph projection response: review page status counts are inconsistent");
  }
  const expectedPrevious = index === 0 ? null : `page:${index - 1}`;
  const expectedNext = index + 1 === pageCount ? null : `page:${index + 1}`;
  if (page.previousCursor !== expectedPrevious || page.nextCursor !== expectedNext) {
    throw new Error("invalid graph projection response: review page continuation is inconsistent");
  }
  return { index, entries, statusCounts, previousCursor: expectedPrevious, nextCursor: expectedNext };
}

function parseReviewSelection(
  value: unknown,
  totalFiles: number,
  side: "head" | "mergeBase",
): NonNullable<GraphProjectionReviewFacts["selection"]> {
  const selection = exactRecord(value, [
    "index", "entry", "graphPath", "graphMatched", "isTest",
  ], "graph projection response review selection", "v9");
  const index = boundedReviewInteger(selection.index, 0, Math.max(0, totalFiles - 1), "selection.index");
  const entry = parseReviewFile(selection.entry, totalFiles);
  if (entry.index !== index || typeof selection.graphMatched !== "boolean") {
    throw new Error("invalid graph projection response: review selection is inconsistent");
  }
  const expectedPath = reviewGraphPathForSide(entry, side);
  if (selection.graphPath !== expectedPath || (expectedPath === null && selection.graphMatched)) {
    throw new Error("invalid graph projection response: review selection path does not match its side");
  }
  if (selection.isTest !== null && typeof selection.isTest !== "boolean") {
    throw new Error("invalid graph projection response: review selection test verdict is malformed");
  }
  if ((expectedPath === null && selection.isTest !== null)
    || (selection.graphMatched && selection.isTest === null)) {
    throw new Error("invalid graph projection response: review selection test verdict has no graph evidence");
  }
  return {
    index,
    entry,
    graphPath: expectedPath,
    graphMatched: selection.graphMatched,
    isTest: selection.isTest,
  };
}

function reviewGraphPathForSide(
  entry: GraphProjectionReviewFile,
  side: "head" | "mergeBase",
): string | null {
  return side === "head"
    ? entry.status === "deleted" ? null : entry.path
    : entry.status === "added" ? null : entry.status === "renamed" ? entry.previousPath! : entry.path;
}

function parseReviewFile(value: unknown, totalFiles: number): GraphProjectionReviewFile {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("invalid graph projection response: review file is malformed");
  }
  const candidate = value as Record<string, unknown>;
  if (candidate.status !== "added" && candidate.status !== "modified"
    && candidate.status !== "deleted" && candidate.status !== "renamed") {
    throw new Error("invalid graph projection response: review file status is malformed");
  }
  const renamed = candidate.status === "renamed";
  const file = exactRecord(
    value,
    renamed ? ["index", "path", "status", "previousPath"] : ["index", "path", "status"],
    "graph projection response review file",
    "v9",
  );
  const index = boundedReviewInteger(file.index, 0, Math.max(0, totalFiles - 1), "file.index");
  const path = reviewPath(file.path, "file.path");
  if (!renamed) return { index, path, status: candidate.status };
  const previousPath = reviewPath(file.previousPath, "file.previousPath");
  if (previousPath === path) {
    throw new Error("invalid graph projection response: renamed review file paths must differ");
  }
  return { index, path, status: "renamed", previousPath };
}

function parseReviewStatusCounts(value: unknown, label: string): GraphProjectionReviewStatusCounts {
  const counts = exactRecord(
    value,
    ["added", "modified", "deleted", "renamed"],
    `graph projection response review ${label}`,
    "v9",
  );
  return {
    added: boundedReviewInteger(counts.added, 0, 100_000, `${label}.added`),
    modified: boundedReviewInteger(counts.modified, 0, 100_000, `${label}.modified`),
    deleted: boundedReviewInteger(counts.deleted, 0, 100_000, `${label}.deleted`),
    renamed: boundedReviewInteger(counts.renamed, 0, 100_000, `${label}.renamed`),
  };
}

function sumReviewStatusCounts(counts: GraphProjectionReviewStatusCounts): number {
  return counts.added + counts.modified + counts.deleted + counts.renamed;
}

function boundedReviewInteger(value: unknown, min: number, max: number, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < min || Number(value) > max) {
    throw new Error(`invalid graph projection response: review ${label} is malformed`);
  }
  return Number(value);
}

function reviewPath(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0 || utf8Bytes(value) > 4_096
    || value.startsWith("/") || /^[A-Za-z]:/.test(value) || value.includes("\\") || value.includes("\0")
    || value.split("/").some((segment) => segment.length === 0 || segment === "." || segment === "..")) {
    throw new Error(`invalid graph projection response: review ${label} is malformed`);
  }
  return value;
}

function parseProjectionAnalysis(
  value: unknown,
  request: GraphProjectionRequest,
  artifact: GraphArtifact,
): { reachability: ReachabilityProjectionFacts | null } {
  const analysis = exactRecord(
    value,
    PROJECTION_ANALYSIS_FIELDS,
    "graph projection response analysis",
    "v9",
  );
  let reachability: ReachabilityProjectionFacts | null = null;
  if (analysis.reachability !== null) {
    try {
      reachability = parseReachabilityProjectionFacts(analysis.reachability);
    } catch (error) {
      throw new Error("invalid graph projection response: reachability is malformed", { cause: error });
    }
  }
  if ((reachability !== null) !== request.includeReachability) {
    throw new Error("invalid graph projection response: reachability does not match the request");
  }
  if (reachability !== null) {
    const nodeIds = new Set(artifact.nodes.map((node) => node.id));
    if ([...Object.keys(reachability.leaves), ...Object.keys(reachability.containers)]
      .some((id) => !nodeIds.has(id))) {
      throw new Error("invalid graph projection response: reachability paint references an omitted node");
    }
  }
  return { reachability };
}

function parseProjectionHierarchy(
  value: unknown,
  artifact: GraphArtifact,
  request: GraphProjectionRequest,
  moduleOverview: GraphModuleOverview | null,
): Pick<GraphStructureFacts, "hierarchyById" | "moduleOverviewRootIds"> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("invalid graph projection response: hierarchy is required");
  }
  const hierarchy = value as Record<string, unknown>;
  if (JSON.stringify(Object.keys(hierarchy).sort())
    !== JSON.stringify(["moduleOverviewRootIds", "nodes"])) {
    throw new Error("invalid graph projection response: hierarchy fields are malformed");
  }
  if (!Array.isArray(hierarchy.moduleOverviewRootIds)
    || hierarchy.moduleOverviewRootIds.some((id) => typeof id !== "string" || id.length === 0)) {
    throw new Error("invalid graph projection response: moduleOverviewRootIds is malformed");
  }
  const moduleOverviewRootIds = hierarchy.moduleOverviewRootIds as string[];
  if (JSON.stringify(moduleOverviewRootIds) !== JSON.stringify([...new Set(moduleOverviewRootIds)].sort())) {
    throw new Error("invalid graph projection response: moduleOverviewRootIds must be sorted and unique");
  }
  if ((request.focusIds.length > 0 || (request.view !== "modules" && request.view !== "ui"))
    && moduleOverviewRootIds.length > 0) {
    throw new Error("invalid graph projection response: overview roots belong only to a repository overview");
  }
  const factRootIds = moduleOverview?.roots.map((root) => root.id) ?? [];
  if (moduleOverviewRootIds.length > 0
    && JSON.stringify(moduleOverviewRootIds) !== JSON.stringify(factRootIds)) {
    throw new Error("invalid graph projection response: overview roots do not match moduleOverview facts");
  }
  if (request.view === "modules" && request.focusIds.length === 0
    && JSON.stringify(moduleOverviewRootIds) !== JSON.stringify(factRootIds)) {
    throw new Error("invalid graph projection response: the modules overview must return every overview root");
  }
  const nodesById = new Map(artifact.nodes.map((node) => [node.id, node]));
  for (const id of moduleOverviewRootIds) {
    const node = nodesById.get(id);
    if (node === undefined || (node.kind !== "package" && node.kind !== "module")) {
      throw new Error("invalid graph projection response: moduleOverviewRootIds contains an unavailable root");
    }
  }
  if (typeof hierarchy.nodes !== "object" || hierarchy.nodes === null || Array.isArray(hierarchy.nodes)) {
    throw new Error("invalid graph projection response: hierarchy.nodes is malformed");
  }
  const factsRecord = hierarchy.nodes as Record<string, unknown>;
  const artifactIds = [...nodesById.keys()].sort();
  if (JSON.stringify(Object.keys(factsRecord).sort()) !== JSON.stringify(artifactIds)) {
    throw new Error("invalid graph projection response: hierarchy must describe every returned node exactly once");
  }
  const loadedFacts = deriveGraphStructure(artifact.nodes, []).hierarchyById;
  const hierarchyById = new Map<string, GraphHierarchyFact>();
  for (const id of artifactIds) {
    const fact = parseHierarchyFact(factsRecord[id], id);
    const loaded = loadedFacts.get(id);
    // Direct children and recursive file totals can only grow when an omitted slice is restored.
    // Overview ownership cannot: omitting a nested package boundary can temporarily make its loose
    // files appear owned by an ancestor. It is therefore authoritative transport metadata, not a
    // fact that can be checked by deriving ownership from an intentionally partial artifact.
    if (loaded === undefined
      || (!request.includeTests && fact.isTest)
      || fact.descendantSourceFileCount < loaded.descendantSourceFileCount
      || Object.entries(loaded.childKindCounts)
        .some(([kind, count]) => (fact.childKindCounts[kind] ?? 0) < count)) {
      throw new Error(`invalid graph projection response: hierarchy fact for ${id} contradicts the loaded slice`);
    }
    hierarchyById.set(id, fact);
  }
  return { hierarchyById, moduleOverviewRootIds };
}

function parseHierarchyFact(value: unknown, nodeId: string): GraphHierarchyFact {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`invalid graph projection response: hierarchy fact for ${nodeId} is malformed`);
  }
  const fact = value as Record<string, unknown>;
  if (JSON.stringify(Object.keys(fact).sort())
    !== JSON.stringify(["childKindCounts", "descendantSourceFileCount", "isTest", "ownedSourceFileCount"])) {
    throw new Error(`invalid graph projection response: hierarchy fact for ${nodeId} has invalid fields`);
  }
  if (!Number.isSafeInteger(fact.descendantSourceFileCount)
    || Number(fact.descendantSourceFileCount) < 0
    || !Number.isSafeInteger(fact.ownedSourceFileCount)
    || Number(fact.ownedSourceFileCount) < 0
    || typeof fact.isTest !== "boolean"
    || typeof fact.childKindCounts !== "object"
    || fact.childKindCounts === null
    || Array.isArray(fact.childKindCounts)) {
    throw new Error(`invalid graph projection response: hierarchy fact for ${nodeId} is malformed`);
  }
  const childKindCounts: Record<string, number> = {};
  for (const [kind, rawCount] of Object.entries(fact.childKindCounts as Record<string, unknown>)) {
    if (kind.length === 0 || kind.includes("\0")
      || !Number.isSafeInteger(rawCount) || Number(rawCount) <= 0) {
      throw new Error(`invalid graph projection response: hierarchy fact for ${nodeId} has invalid child counts`);
    }
    childKindCounts[kind] = Number(rawCount);
  }
  return {
    isTest: fact.isTest,
    childKindCounts,
    descendantSourceFileCount: Number(fact.descendantSourceFileCount),
    ownedSourceFileCount: Number(fact.ownedSourceFileCount),
  };
}

function assertCompleteProjection(value: unknown): void {
  const completeness = exactRecord(
    value,
    PROJECTION_COMPLETENESS_FIELDS,
    "graph projection response completeness",
    "v9",
  );
  if (!Array.isArray(completeness.reasons)
    || completeness.reasons.some((reason) => typeof reason !== "string")
    || !Number.isSafeInteger(completeness.omittedNodes) || Number(completeness.omittedNodes) < 0
    || !Number.isSafeInteger(completeness.omittedEdges) || Number(completeness.omittedEdges) < 0) {
    throw new Error("invalid graph projection response: completeness is malformed");
  }
  if (completeness.complete !== true) {
    const reasons = (completeness.reasons as string[]).join(", ") || "unspecified server limit";
    throw new Error(`graph projection is incomplete: ${reasons}`);
  }
  if ((completeness.reasons as string[]).length > 0
    || completeness.omittedNodes !== 0
    || completeness.omittedEdges !== 0) {
    throw new Error("invalid graph projection response: complete projections cannot report omissions");
  }
}

async function readBoundedResponse(
  response: Response,
  maxBytes: number,
  label = "graph projection response",
): Promise<Uint8Array> {
  const contentType = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (contentType !== "application/json") {
    await cancelUnreadResponse(response, `invalid ${label}: expected application/json`);
    throw new Error(`invalid ${label}: expected application/json`);
  }
  const contentLength = response.headers.get("content-length");
  if (contentLength !== null) {
    const advertised = Number(contentLength);
    if (!Number.isSafeInteger(advertised) || advertised < 0) {
      await cancelUnreadResponse(response, `invalid ${label}: content-length is malformed`);
      throw new Error(`invalid ${label}: content-length is malformed`);
    }
    if (advertised > maxBytes) {
      await cancelUnreadResponse(response, `${label} exceeds its bounded view limit`);
      throw new Error(`${label} exceeds the ${maxBytes}-byte view limit`);
    }
  }
  if (response.body === null) throw new Error(`invalid ${label}: body is required`);
  const reader = response.body.getReader();
  // One fixed buffer is the sole response-body owner. Unknown-length streams reserve their
  // advertised protocol maximum; returning a view preserves the exact payload length without a
  // second joined allocation. Decode admission already reserves that maximum before fetch starts.
  const allocationBytes = contentLength === null ? maxBytes : Number(contentLength);
  const payload = new Uint8Array(allocationBytes);
  let byteLength = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      if (byteLength + value.byteLength > allocationBytes) {
        const message = contentLength === null
          ? `${label} exceeds the ${maxBytes}-byte view limit`
          : `invalid ${label}: content-length does not match the body`;
        try {
          await reader.cancel(message);
        } catch {
          // Preserve the authoritative framing/bounded-view failure below.
        }
        throw new Error(message);
      }
      payload.set(value, byteLength);
      byteLength += value.byteLength;
    }
  } finally {
    reader.releaseLock();
  }
  if (contentLength !== null && Number(contentLength) !== byteLength) {
    throw new Error(`invalid ${label}: content-length does not match the body`);
  }
  return payload.subarray(0, byteLength);
}

async function cancelUnreadResponse(response: Response, reason: string): Promise<void> {
  try {
    await response.body?.cancel(reason);
  } catch {
    // The validation failure is authoritative; a transport cleanup error must not replace it.
  }
}

function decodeStrictUtf8(bytes: Uint8Array, label: string): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error(`invalid ${label}: expected UTF-8`);
  }
}

function isGraphArtifact(value: unknown): value is Record<string, unknown> & {
  schemaVersion: string;
  generatedAt: string;
  nodes: unknown[];
  edges: unknown[];
} {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  return typeof candidate.schemaVersion === "string"
    && typeof candidate.generatedAt === "string"
    && typeof candidate.generator === "object" && candidate.generator !== null && !Array.isArray(candidate.generator)
    && typeof candidate.target === "object" && candidate.target !== null && !Array.isArray(candidate.target)
    && Array.isArray(candidate.nodes)
    && Array.isArray(candidate.edges);
}

function assertSupportedSchema(schemaVersion: string): void {
  const major = Number.parseInt(schemaVersion.split(".")[0] ?? "", 10);
  if (major !== SUPPORTED_SCHEMA_MAJOR) {
    throw new Error(
      `unsupported schema major ${major} (renderer supports ${SUPPORTED_SCHEMA_MAJOR}.x): ${schemaVersion}`,
    );
  }
}

function conservativeResidentBytes(serializedBytes: number, advertised: number | undefined, factor: number): number {
  const expanded = Math.ceil(serializedBytes * factor);
  return Math.max(expanded, advertised ?? 0);
}

function safeByteSum(left: number, right: number): number {
  const total = left + right;
  if (!Number.isSafeInteger(total) || total < 0) {
    throw new RangeError("combined graph projection byte estimate exceeds the safe integer range");
  }
  return total;
}

function boundedInteger(value: number, min: number, max: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new RangeError(`graph projection ${label} must be an integer between ${min} and ${max}`);
  }
  return value;
}

function positiveFinite(value: number, label: string): number {
  if (!Number.isFinite(value) || value <= 0) {
    throw new RangeError(`${label} must be a positive finite number`);
  }
  return value;
}

function isProjectionView(value: unknown): value is GraphProjectionView {
  return value === "modules"
    || value === "service"
    || value === "ui"
    || value === "logic"
    || value === "review";
}

function evictOldest<Key, Value>(cache: Map<Key, Value>, maxEntries: number): void {
  while (cache.size > maxEntries) {
    const oldest = cache.keys().next();
    if (oldest.done) return;
    cache.delete(oldest.value);
  }
}

/**
 * Load one atomic two-sided projection with structured cancellation.
 *
 * The child signal owns only this pair's subscriptions to the shared side flights. If either side
 * fails, cancelling it releases the sibling subscription and waits for both subscription promises
 * to settle. A side transport with another subscriber remains alive because its singleflight owns
 * a separate controller and aborts only after its own final subscriber leaves.
 */
interface AtomicPairDisposal<Left, Right> {
  disposeLeft?(value: Left): void;
  disposeRight?(value: Right): void;
}

async function loadAtomicPair<Left, Right>(
  parentSignal: AbortSignal | undefined,
  loadLeft: (signal: AbortSignal) => Promise<Left>,
  loadRight: (signal: AbortSignal) => Promise<Right>,
  disposal: AtomicPairDisposal<Left, Right> = {},
): Promise<[Left, Right]> {
  const controller = new AbortController();
  const abortFromParent = () => {
    if (!controller.signal.aborted) {
      controller.abort(parentSignal?.reason ?? new DOMException("Review projection cancelled", "AbortError"));
    }
  };
  if (parentSignal?.aborted) abortFromParent();
  else parentSignal?.addEventListener("abort", abortFromParent, { once: true });

  // Defer both factories so a synchronous admission failure on one side cannot prevent the other
  // promise from being tracked and released by the common failure path.
  const leftPending = Promise.resolve().then(() => loadLeft(controller.signal));
  const rightPending = Promise.resolve().then(() => loadRight(controller.signal));
  try {
    const [left, right] = await Promise.all([leftPending, rightPending]);
    return [left, right];
  } catch (error) {
    if (!controller.signal.aborted) controller.abort(error);
    const [left, right] = await Promise.allSettled([leftPending, rightPending]);
    if (left.status === "fulfilled") disposal.disposeLeft?.(left.value);
    if (right.status === "fulfilled") disposal.disposeRight?.(right.value);
    throw error;
  } finally {
    parentSignal?.removeEventListener("abort", abortFromParent);
  }
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  signal?.throwIfAborted();
}

async function awaitWithSignal<T>(pending: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (signal === undefined) return pending;
  signal.throwIfAborted();
  let rejectAbort!: (reason?: unknown) => void;
  const aborted = new Promise<never>((_resolve, reject) => {
    rejectAbort = reject;
  });
  const onAbort = () => rejectAbort(signal.reason ?? new DOMException("Aborted", "AbortError"));
  signal.addEventListener("abort", onAbort, { once: true });
  try {
    return await Promise.race([pending, aborted]);
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}
