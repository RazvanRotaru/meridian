/**
 * Versioned partial-graph and symbol-search transport contracts.
 *
 * A projection is a standalone response shape, not a `GraphArtifact` extension. It repeats the
 * canonical artifact metadata needed to interpret its nodes and edges while making slice
 * completeness explicit. Consumers must compare the immutable graph's stable `generation` before
 * merging asynchronously delivered projections or symbol results.
 */

import type {
  Generator,
  GraphEdge,
  GraphNode,
  JsonValue,
  NodeId,
  NodeKind,
  Target,
  TelemetryContract,
} from "./types";

export const GRAPH_PROJECTION_VERSION = 1 as const;
export const GRAPH_SYMBOL_SEARCH_VERSION = 1 as const;

/** Counts for either the complete source graph or the returned projection slice. */
export interface GraphProjectionCounts {
  nodes: number;
  edges: number;
  /** Canonical file/module nodes, not distinct source-location strings. */
  files: number;
}

/** Per-file boundary state for continuing an iterative graph traversal. */
export interface GraphProjectionFrontierEntry {
  fileId: NodeId;
  /** True when the source graph has known neighbours beyond the returned slice. */
  hasMore: boolean;
  /** Greatest traversal depth known to be complete for this frontier file. */
  completeThroughDepth: number;
}

/** Request body for the version-one graph projection endpoint. */
export interface GraphProjectionRequestV1 {
  version: typeof GRAPH_PROJECTION_VERSION;
  graphId: string;
  roots:
    /** Resolve the changed-file manifest attached to `seedGraphId` into canonical file roots. */
    | { kind: "changed-files"; seedGraphId: string }
    /** Continue from explicit canonical file/module nodes, including command-palette additions. */
    | { kind: "files"; fileIds: NodeId[] }
    /** Resolve exact canonical `location.file` values in the target graph. This is used only when
     * a second immutable graph (for example a PR merge base) exposes context whose node IDs must
     * never be treated as identities in the target graph. Missing paths are intentionally ignored. */
    | { kind: "file-paths"; paths: string[] };
  /** Visible traversal depth required before the roots may be admitted. */
  requestedDepth: number;
  /** Absolute bounded horizon the client may ask a later cache-only warm request to prepare. The
   * critical response computes only `requestedDepth`; this field never delays canvas admission. */
  prefetchDepth: number;
}

/**
 * A self-describing, incrementally loadable slice of one canonical graph artifact.
 *
 * `graphId` identifies the artifact whose nodes and edges are returned. `seedGraphId` records the
 * graph whose manifest or selection supplied the traversal roots; self-seeded projections repeat
 * `graphId`. `generation` is an opaque, stable identity for that immutable graph and is shared by
 * its projection and symbol-search responses. It is deliberately a string rather than a sequence
 * number.
 */
export interface GraphProjectionV1 {
  version: typeof GRAPH_PROJECTION_VERSION;
  graphId: string;
  seedGraphId: string;
  generation: string;

  /** User-requested visible traversal depth. */
  requestedDepth: number;
  /** Advertised upper horizon for separately scheduled, post-actionable cache warming. */
  prefetchDepth: number;
  /** Traversal depth actually computed into this immutable projection cache entry. */
  loadedDepth: number;

  // Canonical GraphArtifact header and target metadata. These are repeated intentionally: this
  // contract is independently transportable and is not embedded into GraphArtifact.extensions.
  schemaVersion: string;
  generatedAt: string;
  generator: Generator;
  target: Target;
  telemetry?: TelemetryContract;
  extensions?: Record<string, JsonValue>;

  nodes: GraphNode[];
  edges: GraphEdge[];

  /** Canonical file/module node IDs from which this projection was traversed. */
  rootFileIds: NodeId[];
  /** Roots whose admission requirements are complete and safe to render. */
  readyFileIds: NodeId[];
  /** Every canonical file/module node represented by the returned slice. */
  loadedFileIds: NodeId[];
  frontier: GraphProjectionFrontierEntry[];

  counts: {
    /** Counts in the complete source artifact. */
    full: GraphProjectionCounts;
    /** Counts represented by this response's nodes, edges, and file IDs. */
    slice: GraphProjectionCounts;
  };
}

/** Compact symbol metadata that can be searched before its graph neighbourhood is hydrated. */
export interface CompactGraphSymbolEntry {
  id: NodeId;
  /** Canonical owning file/module node to hydrate when this symbol is selected. */
  fileId: NodeId;
  displayName: string;
  qualifiedName: string;
  kind: NodeKind;
  /** Extraction-root-relative source path, retained for the palette's disambiguation row. */
  file: string;
  /** Matches the command palette's opt-in private-method scope. */
  isPrivateMethod: boolean;
  /** Executable logic-flow step count; null means no searchable flow is available. */
  stepCount: number | null;
}

/** A partial or complete snapshot from the background symbol index. */
export interface GraphSymbolSearchResultV1 {
  version: typeof GRAPH_SYMBOL_SEARCH_VERSION;
  graphId: string;
  /** The same immutable-graph generation emitted by GraphProjectionV1. */
  generation: string;
  /** True only when every source-graph symbol satisfying the hydration contract has been indexed. */
  complete: boolean;
  indexedSymbolCount: number;
  totalSymbolCount: number;
  symbols: CompactGraphSymbolEntry[];
}
