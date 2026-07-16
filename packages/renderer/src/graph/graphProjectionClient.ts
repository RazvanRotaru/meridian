/**
 * HTTP transport for disk-backed graph projections.
 *
 * A projection is still a valid GraphArtifact, but it contains only the nodes, edges, and
 * extension slices needed by one renderer view. The currently displayed projection is pinned;
 * decoded projections visited recently live in a byte-bounded LRU so browser Back/Forward can be
 * instant without letting navigation rebuild an unbounded in-memory graph cache.
 */

import type { GraphArtifact } from "@meridian/core";
import { buildGraphIndex, type GraphIndex } from "./graphIndex";
import {
  DEFAULT_RECENT_ALLOCATION_BUDGET_LIMITS,
  type RecentAllocationBudget,
  RecentViewProjectionCache,
  type RecentViewProjectionCacheLimits,
} from "../state/recentViewProjectionCache";
import { PERFORMANCE, startPerformanceSpan } from "../boot/performanceMarks";

const SUPPORTED_SCHEMA_MAJOR = 1;
const PROJECTION_TRANSPORT_VERSION = 2;
const DEFAULT_RESIDENT_EXPANSION_FACTOR = 3;
const MAX_MANIFEST_CACHE_ENTRIES = 16;
const MAX_IN_FLIGHT_MANIFESTS = 16;
const MAX_IN_FLIGHT_PROJECTIONS = 32;
const MAX_FOCUS_IDS = 32;
const MAX_EXPANDED_IDS = 512;
const MAX_EXTRA_IDS = 128;
const MAX_ID_BYTES = 2_048;
const MAX_FILE_PATHS = 512;
const MAX_FILE_PATH_BYTES = 2_048;
const MAX_FILE_PATHS_BYTES = 48 * 1024;
const DEFAULT_MAX_NODES = 5_000;
const DEFAULT_MAX_EDGES = 20_000;
const DEFAULT_MAX_RESPONSE_BYTES = 16 * 1024 * 1024;
const MIN_MAX_RESPONSE_BYTES = 64 * 1024;

export type GraphProjectionView =
  | "modules"
  | "call"
  | "ui"
  | "logic"
  | "review";

/** The renderer/server projection contract. Every id collection is canonicalized before use. */
export interface GraphProjectionRequest {
  view: GraphProjectionView;
  /** Canonical root-relative POSIX paths used to route PR review slices on both revisions. */
  filePaths: readonly string[];
  focusIds: readonly string[];
  expandedIds: readonly string[];
  extraIds: readonly string[];
  depth: number;
  radius: number;
  includeTests: boolean;
  maxNodes?: number;
  maxEdges?: number;
  maxResponseBytes?: number;
}

export interface GraphProjectionManifest {
  version: number;
  graphId: string;
  contentId: string;
  graphSummary: {
    schemaVersion: string;
    generatedAt: string;
    nodeCount: number;
    edgeCount: number;
  };
  defaultProjectionId?: string;
  defaultView: GraphProjectionRequest;
  /** Forward-compatible server fields (completeness, continuations, child counts, and so on). */
  readonly [key: string]: unknown;
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
  serializedBytes: number;
  residentBytes: number;
}

export interface GraphProjectionEndpoints {
  manifestUrl: string;
  projectionUrl: string;
}

export interface GraphProjectionActivateOptions {
  signal?: AbortSignal;
  /** Exact immutable endpoints returned by direct PR preparation. */
  endpoints?: GraphProjectionEndpoints;
}

export interface GraphProjectionReviewPairOptions {
  head: { request: GraphProjectionRequest; endpoints: GraphProjectionEndpoints };
  mergeBase: { request: GraphProjectionRequest; endpoints: GraphProjectionEndpoints };
  signal?: AbortSignal;
}

export interface GraphProjectionDataSource {
  readonly activeKey: string | undefined;
  loadManifest(options?: GraphProjectionActivateOptions): Promise<GraphProjectionManifest>;
  activate(
    request: GraphProjectionRequest,
    options?: GraphProjectionActivateOptions,
  ): Promise<LoadedGraphProjection>;
  activateReviewPair(options: GraphProjectionReviewPairOptions): Promise<LoadedReviewProjection>;
  activateCached(key: string): LoadedGraphProjection | undefined;
  activateCachedReview(key: string): LoadedReviewProjection | undefined;
}

export interface GraphProjectionClientOptions {
  fetch?: typeof fetch;
  /** Multiplier from serialized response bytes to decoded artifact + index heap estimate. */
  residentExpansionFactor?: number;
  recentCache?: Partial<RecentViewProjectionCacheLimits>;
  /** Optional browser-wide coordinator shared with decoded scene/navigation caches. */
  recentBudget?: RecentAllocationBudget;
}

export class GraphProjectionClient implements GraphProjectionDataSource {
  private readonly fetchImpl: typeof fetch;
  private readonly residentExpansionFactor: number;
  private readonly cache: RecentViewProjectionCache<string, CachedProjection>;
  /** Settled manifests are a small LRU; live reads remain separately bounded and cancellable. */
  private readonly manifests = new Map<string, GraphProjectionManifest>();
  private readonly inFlightManifests = new Map<string, SharedProjectionFlight<GraphProjectionManifest>>();
  /** Single and composite reads share side flights, so a concurrent HEAD-only + review-pair read
   * decodes/indexes that HEAD exactly once. Each flight aborts only after its final subscriber. */
  private readonly inFlightSides = new Map<string, SharedProjectionFlight<LoadedGraphProjection>>();
  private readonly inFlightReviews = new Map<string, SharedProjectionFlight<LoadedReviewProjection>>();
  /** String-only aliases keep a cached review pair as the sole owner of both decoded sides. */
  private readonly reviewSideAliases = new Map<string, ReviewSideAlias>();

  constructor(
    private readonly manifestUrl: string,
    private readonly projectionUrl: string,
    options: GraphProjectionClientOptions = {},
  ) {
    // Browser-native fetch performs a Web IDL receiver check. Keeping it as an object field and
    // calling `this.fetchImpl(...)` would otherwise supply the GraphProjectionClient as `this`,
    // which Chromium rejects with "Illegal invocation". Injected test/custom fetches retain their
    // own call contract; only the native global needs binding.
    this.fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.residentExpansionFactor = positiveFinite(
      options.residentExpansionFactor ?? DEFAULT_RESIDENT_EXPANSION_FACTOR,
      "residentExpansionFactor",
    );
    this.cache = new RecentViewProjectionCache({
      maxRecentEntries: options.recentCache?.maxRecentEntries
        ?? DEFAULT_RECENT_ALLOCATION_BUDGET_LIMITS.maxRecentEntries,
      maxRecentBytes: options.recentCache?.maxRecentBytes
        ?? DEFAULT_RECENT_ALLOCATION_BUDGET_LIMITS.maxRecentBytes,
    }, options.recentBudget);
  }

  get activeKey(): string | undefined {
    return this.cache.activeKey;
  }

  async loadManifest(options: GraphProjectionActivateOptions = {}): Promise<GraphProjectionManifest> {
    const url = options.endpoints?.manifestUrl ?? this.manifestUrl;
    throwIfAborted(options.signal);
    const cached = this.manifests.get(url);
    if (cached !== undefined) {
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
    this.manifests.delete(url);
    this.manifests.set(url, loaded);
    evictOldest(this.manifests, MAX_MANIFEST_CACHE_ENTRIES);
    return loaded;
  }

  async activate(
    request: GraphProjectionRequest,
    options: GraphProjectionActivateOptions = {},
  ): Promise<LoadedGraphProjection> {
    const canonical = canonicalizeProjectionRequest(request);
    const manifest = await this.loadManifest(options);
    throwIfAborted(options.signal);
    const key = canonicalProjectionKey(manifest.graphId, canonical);
    const aliased = this.activateReviewSideAlias(key);
    if (aliased !== undefined) return aliased;
    const cached = this.cache.peek(key);
    if (cached?.kind === "single") {
      return this.activateSingleEntry(key);
    }
    const projectionEndpoint = options.endpoints?.projectionUrl ?? this.projectionUrl;
    const projection = await this.subscribeProjection(
      this.inFlightSides,
      key,
      (signal) => this.fetchProjection(manifest.graphId, canonical, projectionEndpoint, signal),
      options.signal,
    );
    throwIfAborted(options.signal);
    const publishedReviewSide = this.activateReviewSideAlias(key);
    if (publishedReviewSide !== undefined) return publishedReviewSide;
    this.cache.setActive(key, { kind: "single", projection }, projection.residentBytes);
    this.pruneReviewSideAliases();
    return projection;
  }

  async activateReviewPair(options: GraphProjectionReviewPairOptions): Promise<LoadedReviewProjection> {
    const headRequest = canonicalizeProjectionRequest(options.head.request);
    const mergeBaseRequest = canonicalizeProjectionRequest(options.mergeBase.request);
    if (headRequest.view !== "review" || mergeBaseRequest.view !== "review") {
      throw new TypeError("review projection pairs require view: review on both revisions");
    }
    const [headManifest, mergeBaseManifest] = await Promise.all([
      this.loadManifest({ endpoints: options.head.endpoints, signal: options.signal }),
      this.loadManifest({ endpoints: options.mergeBase.endpoints, signal: options.signal }),
    ]);
    throwIfAborted(options.signal);
    const headKey = canonicalProjectionKey(headManifest.graphId, headRequest);
    const mergeBaseKey = canonicalProjectionKey(mergeBaseManifest.graphId, mergeBaseRequest);
    const key = canonicalReviewProjectionKey(headKey, mergeBaseKey);
    const cached = this.cache.peek(key);
    if (cached?.kind === "review") {
      this.rememberReviewSideAliases(key, headKey, mergeBaseKey);
      return this.activateReviewEntry(key);
    }

    // Decode/index both sides before publishing either. A malformed or stale merge-base therefore
    // cannot replace a still-usable active projection with a half-loaded review.
    const projection = await this.subscribeProjection(this.inFlightReviews, key, async (reviewSignal) => {
      const [head, mergeBase] = await Promise.all([
        this.subscribeProjection(
          this.inFlightSides,
          headKey,
          (signal) => this.fetchProjection(
            headManifest.graphId,
            headRequest,
            options.head.endpoints.projectionUrl,
            signal,
          ),
          reviewSignal,
        ),
        this.subscribeProjection(
          this.inFlightSides,
          mergeBaseKey,
          (signal) => this.fetchProjection(
            mergeBaseManifest.graphId,
            mergeBaseRequest,
            options.mergeBase.endpoints.projectionUrl,
            signal,
          ),
          reviewSignal,
        ),
      ]);
      return {
        key,
        projectionId: `${head.projectionId}\u0000${mergeBase.projectionId}`,
        head,
        mergeBase,
        serializedBytes: safeByteSum(head.serializedBytes, mergeBase.serializedBytes),
        residentBytes: safeByteSum(head.residentBytes, mergeBase.residentBytes),
      };
    }, options.signal);
    throwIfAborted(options.signal);
    const supersededReviews = [
      this.reviewSideAliases.get(headKey)?.reviewKey,
      this.reviewSideAliases.get(mergeBaseKey)?.reviewKey,
    ].filter((candidate): candidate is string => candidate !== undefined && candidate !== key);
    this.cache.setActiveReplacing(
      key,
      { kind: "review", projection },
      projection.residentBytes,
      [headKey, mergeBaseKey, ...supersededReviews],
    );
    this.rememberReviewSideAliases(key, headKey, mergeBaseKey);
    this.pruneReviewSideAliases();
    return projection;
  }

  activateCached(key: string): LoadedGraphProjection | undefined {
    return this.activateReviewSideAlias(key)
      ?? (this.cache.peek(key)?.kind === "single" ? this.activateSingleEntry(key) : undefined);
  }

  activateCachedReview(key: string): LoadedReviewProjection | undefined {
    return this.cache.peek(key)?.kind === "review" ? this.activateReviewEntry(key) : undefined;
  }

  private activateSingleEntry(key: string): LoadedGraphProjection {
    const cached = this.cache.activate(key);
    if (cached?.kind !== "single") throw new Error("graph projection cache kind changed during activation");
    this.pruneReviewSideAliases();
    return cached.projection;
  }

  private activateReviewEntry(key: string): LoadedReviewProjection {
    const cached = this.cache.activate(key);
    if (cached?.kind !== "review") throw new Error("graph projection cache kind changed during activation");
    this.pruneReviewSideAliases();
    return cached.projection;
  }

  private activateReviewSideAlias(key: string): LoadedGraphProjection | undefined {
    const alias = this.reviewSideAliases.get(key);
    if (alias === undefined) return undefined;
    const cached = this.cache.peek(alias.reviewKey);
    if (cached?.kind !== "review") {
      this.reviewSideAliases.delete(key);
      return undefined;
    }
    const review = this.activateReviewEntry(alias.reviewKey);
    return alias.side === "head" ? review.head : review.mergeBase;
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
      throw flight.controller.signal.reason ?? new DOMException("Shared projection read is cancelling", "AbortError");
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

  private async fetchProjection(
    graphId: string,
    request: GraphProjectionRequest,
    endpoint: string,
    signal?: AbortSignal,
  ): Promise<LoadedGraphProjection> {
    const finishTransfer = startPerformanceSpan(PERFORMANCE.projectionTransfer);
    let response: Response;
    let payloadBytes: ArrayBuffer;
    try {
      response = await this.fetchImpl(endpoint, {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify(request),
        signal,
      });
      if (!response.ok) {
        throw new Error(`graph projection fetch failed (${response.status}) from ${response.url || endpoint}`);
      }
      payloadBytes = await readBoundedResponse(
        response,
        request.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES,
      );
    } finally {
      finishTransfer();
    }
    throwIfAborted(signal);
    const finishParse = startPerformanceSpan(PERFORMANCE.projectionParse);
    let decoded: ReturnType<typeof decodeProjectionResponse>;
    try {
      decoded = decodeProjectionResponse(payloadBytes, response.headers, request);
    } finally {
      finishParse();
    }
    const residentBytes = conservativeResidentBytes(
      payloadBytes.byteLength,
      decoded.residentBytes,
      this.residentExpansionFactor,
    );
    const finishIndex = startPerformanceSpan(PERFORMANCE.projectionIndex);
    let index: GraphIndex;
    try {
      index = buildGraphIndex(decoded.artifact);
    } finally {
      finishIndex();
    }
    const key = canonicalProjectionKey(graphId, request);
    return {
      key,
      projectionId: decoded.projectionId ?? key,
      graphId,
      request,
      artifact: decoded.artifact,
      index,
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

interface SharedProjectionFlight<T> {
  promise: Promise<T>;
  controller: AbortController;
  subscribers: number;
  settled: boolean;
}

function settleProjectionFlight<T>(
  map: Map<string, SharedProjectionFlight<T>>,
  key: string,
  flight: SharedProjectionFlight<T>,
): void {
  flight.settled = true;
  if (map.get(key) === flight) map.delete(key);
}

export const OVERVIEW_PROJECTION_REQUEST: GraphProjectionRequest = {
  view: "modules",
  filePaths: [],
  focusIds: [],
  expandedIds: [],
  extraIds: [],
    depth: 1,
    radius: 0,
    includeTests: false,
    maxNodes: DEFAULT_MAX_NODES,
    maxEdges: DEFAULT_MAX_EDGES,
    maxResponseBytes: DEFAULT_MAX_RESPONSE_BYTES,
};

/** Stable key shared by in-flight cancellation, the decoded-view LRU, and browser navigation. */
export function canonicalProjectionKey(graphId: string, request: GraphProjectionRequest): string {
  return `${graphId}\u0000${JSON.stringify(canonicalizeProjectionRequest(request))}`;
}

/** A composite key makes HEAD+merge-base one navigation target and one byte-charged cache entry. */
export function canonicalReviewProjectionKey(headKey: string, mergeBaseKey: string): string {
  return `review-pair\u0000${JSON.stringify([headKey, mergeBaseKey])}`;
}

export function canonicalizeProjectionRequest(request: GraphProjectionRequest): GraphProjectionRequest {
  if (!isProjectionView(request.view)) {
    throw new TypeError(`unsupported graph projection view: ${String(request.view)}`);
  }
  if (!Number.isSafeInteger(request.depth) || request.depth < 0 || request.depth > 4) {
    throw new RangeError("graph projection depth must be an integer between 0 and 4");
  }
  if (!Number.isSafeInteger(request.radius) || request.radius < 0 || request.radius > 3) {
    throw new RangeError("graph projection radius must be an integer between 0 and 3");
  }
  if (typeof request.includeTests !== "boolean") {
    throw new TypeError("graph projection includeTests must be boolean");
  }
  const maxNodes = boundedInteger(request.maxNodes ?? DEFAULT_MAX_NODES, 1, DEFAULT_MAX_NODES, "maxNodes");
  const maxEdges = boundedInteger(request.maxEdges ?? DEFAULT_MAX_EDGES, 0, DEFAULT_MAX_EDGES, "maxEdges");
  const maxResponseBytes = boundedInteger(
    request.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES,
    MIN_MAX_RESPONSE_BYTES,
    DEFAULT_MAX_RESPONSE_BYTES,
    "maxResponseBytes",
  );
  const filePaths = canonicalFilePaths(request.filePaths);
  if (request.view !== "review" && filePaths.length > 0) {
    throw new TypeError("graph projection filePaths are valid only for the review view");
  }
  return {
    view: request.view,
    filePaths,
    focusIds: canonicalIds(request.focusIds, MAX_FOCUS_IDS, "focusIds"),
    expandedIds: canonicalIds(request.expandedIds, MAX_EXPANDED_IDS, "expandedIds"),
    extraIds: canonicalIds(request.extraIds, MAX_EXTRA_IDS, "extraIds"),
    depth: request.depth,
    radius: request.radius,
    includeTests: request.includeTests === true,
    maxNodes,
    maxEdges,
    maxResponseBytes,
  };
}

function canonicalIds(ids: readonly string[], limit: number, label: string): string[] {
  if (!Array.isArray(ids) || ids.length > limit) {
    throw new RangeError(`graph projection ${label} exceeds its limit`);
  }
  const canonical = new Set<string>();
  for (const id of ids) {
    if (typeof id !== "string" || id.length === 0 || id.includes("\0") || utf8Bytes(id) > MAX_ID_BYTES) {
      throw new TypeError(`graph projection ${label} contains an invalid graph id`);
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
    throw new Error(`graph projection manifest fetch failed (${response.status}) from ${response.url || url}`);
  }
  const raw = await response.json() as unknown;
  return parseManifest(raw);
}

function parseManifest(raw: unknown): GraphProjectionManifest {
  if (typeof raw !== "object" || raw === null) {
    throw new Error("invalid graph projection manifest: expected an object");
  }
  const candidate = raw as Record<string, unknown>;
  if (candidate.version !== PROJECTION_TRANSPORT_VERSION) {
    throw new Error(`invalid graph projection manifest: expected version ${PROJECTION_TRANSPORT_VERSION}`);
  }
  if (typeof candidate.graphId !== "string" || candidate.graphId.length === 0) {
    throw new Error("invalid graph projection manifest: graphId is required");
  }
  if (typeof candidate.contentId !== "string" || !/^[0-9a-f]{64}$/i.test(candidate.contentId)) {
    throw new Error("invalid graph projection manifest: contentId must be a 64-character hex digest");
  }
  if (typeof candidate.graphSummary !== "object" || candidate.graphSummary === null
    || Array.isArray(candidate.graphSummary)) {
    throw new Error("invalid graph projection manifest: graphSummary is required");
  }
  const summary = candidate.graphSummary as Record<string, unknown>;
  if (typeof summary.schemaVersion !== "string" || summary.schemaVersion.length === 0
    || typeof summary.generatedAt !== "string" || summary.generatedAt.length === 0
    || !Number.isSafeInteger(summary.nodeCount) || Number(summary.nodeCount) < 0
    || !Number.isSafeInteger(summary.edgeCount) || Number(summary.edgeCount) < 0) {
    throw new Error("invalid graph projection manifest: graphSummary is malformed");
  }
  if (candidate.defaultView === undefined) {
    throw new Error("invalid graph projection manifest: defaultView is required");
  }
  const manifest: GraphProjectionManifest = {
    ...candidate,
    version: candidate.version as number,
    graphId: candidate.graphId,
    contentId: candidate.contentId,
    graphSummary: {
      schemaVersion: summary.schemaVersion,
      generatedAt: summary.generatedAt,
      nodeCount: Number(summary.nodeCount),
      edgeCount: Number(summary.edgeCount),
    },
    defaultView: parseProjectionRequest(candidate.defaultView),
  };
  if (typeof candidate.defaultProjectionId === "string") {
    manifest.defaultProjectionId = candidate.defaultProjectionId;
  }
  return manifest;
}

function parseProjectionRequest(raw: unknown): GraphProjectionRequest {
  if (typeof raw !== "object" || raw === null) {
    throw new Error("invalid graph projection request in manifest");
  }
  const candidate = raw as Record<string, unknown>;
  return canonicalizeProjectionRequest({
    view: candidate.view as GraphProjectionView,
    filePaths: manifestStringArray(candidate.filePaths, "filePaths"),
    focusIds: manifestStringArray(candidate.focusIds, "focusIds"),
    expandedIds: manifestStringArray(candidate.expandedIds, "expandedIds"),
    extraIds: manifestStringArray(candidate.extraIds, "extraIds"),
    depth: typeof candidate.depth === "number" ? candidate.depth : 1,
    radius: typeof candidate.radius === "number" ? candidate.radius : 0,
    includeTests: candidate.includeTests === true,
    maxNodes: typeof candidate.maxNodes === "number" ? candidate.maxNodes : DEFAULT_MAX_NODES,
    maxEdges: typeof candidate.maxEdges === "number" ? candidate.maxEdges : DEFAULT_MAX_EDGES,
    maxResponseBytes: typeof candidate.maxResponseBytes === "number"
      ? candidate.maxResponseBytes
      : DEFAULT_MAX_RESPONSE_BYTES,
  });
}

function manifestStringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error(`invalid graph projection request in manifest: ${label}`);
  }
  return value as string[];
}

function decodeProjectionResponse(
  bytes: ArrayBuffer,
  headers: Headers,
  expectedRequest: GraphProjectionRequest,
): { projectionId?: string; artifact: GraphArtifact; residentBytes?: number } {
  let raw: unknown;
  try {
    raw = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new Error("invalid graph projection response: expected JSON");
  }
  if (typeof raw !== "object" || raw === null) {
    throw new Error("invalid graph projection response: expected an object");
  }
  const record = raw as Record<string, unknown>;
  const envelope = {
    artifact: record.artifact,
    projectionId: record.projectionId,
    residentBytes: record.residentBytes,
  };
  if (!isGraphArtifact(envelope.artifact)) {
    throw new Error("invalid graph projection response: artifact is required");
  }
  const returnedRequest = parseProjectionRequest(record.request);
  if (JSON.stringify(returnedRequest) !== JSON.stringify(expectedRequest)) {
    throw new Error("invalid graph projection response: request identity does not match");
  }
  assertCompleteProjection(record.completeness);
  assertSupportedSchema(envelope.artifact.schemaVersion);
  const headerProjectionId = headers.get("x-meridian-projection-id");
  return {
    artifact: envelope.artifact as unknown as GraphArtifact,
    projectionId: typeof envelope.projectionId === "string"
      ? envelope.projectionId
      : headerProjectionId ?? undefined,
    residentBytes: typeof envelope.residentBytes === "number" && Number.isSafeInteger(envelope.residentBytes)
      && envelope.residentBytes >= 0
      ? envelope.residentBytes
      : undefined,
  };
}

function assertCompleteProjection(value: unknown): void {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("invalid graph projection response: completeness is required");
  }
  const completeness = value as Record<string, unknown>;
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
}

async function readBoundedResponse(response: Response, maxBytes: number): Promise<ArrayBuffer> {
  const contentLength = response.headers.get("content-length");
  if (contentLength !== null) {
    const advertised = Number(contentLength);
    if (!Number.isSafeInteger(advertised) || advertised < 0) {
      throw new Error("invalid graph projection response: content-length is malformed");
    }
    if (advertised > maxBytes) {
      throw new Error(`graph projection response exceeds the ${maxBytes}-byte view limit`);
    }
  }
  if (response.body === null) throw new Error("invalid graph projection response: body is required");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      byteLength += value.byteLength;
      if (byteLength > maxBytes) {
        await reader.cancel("graph projection response exceeded its bounded view limit");
        throw new Error(`graph projection response exceeds the ${maxBytes}-byte view limit`);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const joined = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return joined.buffer;
}

function isGraphArtifact(value: unknown): value is Record<string, unknown> & {
  schemaVersion: string;
  nodes: unknown[];
  edges: unknown[];
} {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return typeof candidate.schemaVersion === "string"
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
    || value === "call"
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
