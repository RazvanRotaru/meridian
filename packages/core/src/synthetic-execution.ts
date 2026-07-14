/**
 * Contracts for one explicitly configured, synthetic-input execution.
 *
 * The manifest is repository-owned configuration: it says how to obtain a callable for a graph
 * node and supplies an editable default input. The execution result deliberately reuses the
 * request-trace contract, so generated runs join and render through the same node/span path as
 * imported telemetry. Node snapshots are an additive, bounded-data side channel for the PR review
 * experience; they do not pretend arbitrary JSON objects are OpenTelemetry attributes.
 */

import { z } from "zod";
import { nodeIdSchema } from "./schema";
import { requestTraceSchema } from "./trace";
import type { RequestTrace } from "./trace";
import type { JsonValue } from "./types";

export const SYNTHETIC_EXECUTION_VERSION = "1.0.0" as const;
export const SYNTHETIC_MANIFEST_VERSION = "1.0.0" as const;

const idSchema = z.string().trim().min(1).max(256);
const labelSchema = z.string().trim().min(1).max(512);
const descriptionSchema = z.string().max(4_096);
const MAX_JSON_DEPTH = 12;
const MAX_JSON_NODES = 4_096;
const MAX_JSON_COLLECTION = 512;
const MAX_JSON_STRING = 16_384;
const MAX_INPUT_OVERRIDES = 128;
const MAX_FIELD_WATCHERS = 128;
const MAX_WATCH_HITS = 512;
const MAX_OCCURRENCE_KEY = 16_384;
const forbiddenPathSegments = new Set(["__proto__", "prototype", "constructor"]);

/** JSON rather than `unknown`: manifests, runner inputs, and snapshots must cross a process
 * boundary without prototypes, functions, symbols, bigint, or undefined. */
export const syntheticJsonValueSchema: z.ZodType<JsonValue> = z.lazy(() => z.union([
  z.string().max(MAX_JSON_STRING),
  z.number().finite(),
  z.boolean(),
  z.null(),
  z.array(syntheticJsonValueSchema).max(MAX_JSON_COLLECTION),
  z.record(z.string().max(1_024), syntheticJsonValueSchema).refine(
    (value) => Object.keys(value).length <= MAX_JSON_COLLECTION,
    `JSON objects may contain at most ${MAX_JSON_COLLECTION} properties`,
  ),
]));

/** The recursive schema enforces each collection; this root refinement additionally bounds an
 * entire value so deeply nested or very broad inputs cannot consume unbounded runner/renderer
 * memory. Kept separate so recursive children do not repeat a whole-tree traversal. */
export const boundedSyntheticJsonValueSchema: z.ZodType<JsonValue> = syntheticJsonValueSchema.superRefine((value, ctx) => {
  const issue = syntheticJsonLimitIssue(value);
  if (issue) ctx.addIssue({ code: "custom", message: issue });
});

const occurrenceKeySchema = z.string().min(1).max(MAX_OCCURRENCE_KEY);
const safePathSegmentSchema = z.string().max(1_024).refine(
  (segment) => !forbiddenPathSegments.has(segment),
  "field paths may not traverse prototype properties",
);

export interface SyntheticOccurrenceTarget {
  nodeId: string;
  occurrenceKey: string;
}

export const syntheticOccurrenceTargetSchema: z.ZodType<SyntheticOccurrenceTarget> = z.object({
  nodeId: nodeIdSchema,
  occurrenceKey: occurrenceKeySchema,
});

export interface SyntheticInputOverride {
  id: string;
  target: SyntheticOccurrenceTarget;
  /** Complete boundary input object, keyed by the callable's parameter names. */
  input: JsonValue;
}

export const syntheticInputOverrideSchema: z.ZodType<SyntheticInputOverride> = z.object({
  id: idSchema,
  target: syntheticOccurrenceTargetSchema,
  input: boundedSyntheticJsonValueSchema.refine(
    (value) => typeof value === "object" && value !== null && !Array.isArray(value),
    "input overrides must use the callable boundary input object",
  ),
});

export type SyntheticFieldWatcherOperator = "exists" | "equals" | "changes";
export type SyntheticFieldWatcherPhase = "input" | "output";

export interface SyntheticFieldWatcher {
  id: string;
  nodeId?: string;
  occurrenceKey?: string;
  phase: SyntheticFieldWatcherPhase;
  path: string[];
  operator: SyntheticFieldWatcherOperator;
  expected?: JsonValue;
}

export const syntheticFieldWatcherSchema: z.ZodType<SyntheticFieldWatcher> = z.object({
  id: idSchema,
  nodeId: nodeIdSchema.optional(),
  occurrenceKey: occurrenceKeySchema.optional(),
  phase: z.enum(["input", "output"]),
  path: z.array(safePathSegmentSchema).max(64),
  operator: z.enum(["exists", "equals", "changes"]),
  expected: boundedSyntheticJsonValueSchema.optional(),
}).superRefine((watcher, ctx) => {
  if (watcher.operator === "equals" && watcher.expected === undefined) {
    ctx.addIssue({ code: "custom", path: ["expected"], message: "equals watchers require an expected value" });
  }
  if (watcher.operator !== "equals" && watcher.expected !== undefined) {
    ctx.addIssue({ code: "custom", path: ["expected"], message: "expected is only valid for equals watchers" });
  }
});

export const syntheticInputOverridesSchema = z.array(syntheticInputOverrideSchema)
  .max(MAX_INPUT_OVERRIDES)
  .superRefine((overrides, ctx) => validateUniqueRuntimeControls(overrides, ctx, true));

export const syntheticFieldWatchersSchema = z.array(syntheticFieldWatcherSchema)
  .max(MAX_FIELD_WATCHERS)
  .superRefine((watchers, ctx) => validateUniqueRuntimeControls(watchers, ctx, false));

export interface SyntheticScenarioDescriptor {
  id: string;
  label: string;
  rootId: string;
  description?: string;
  defaultInput: JsonValue;
}

const syntheticScenarioDescriptorShape = {
  id: idSchema,
  label: labelSchema,
  rootId: nodeIdSchema,
  description: descriptionSchema.optional(),
  defaultInput: boundedSyntheticJsonValueSchema,
};

export const syntheticScenarioDescriptorSchema = z.object(syntheticScenarioDescriptorShape) satisfies z.ZodType<SyntheticScenarioDescriptor>;

export interface SyntheticExecutionInvoke {
  /** Project-relative TypeScript module that owns the exported function/factory. */
  module: string;
  /** Exported function. Called with input directly when `method` is absent, otherwise as a
   * zero-argument factory whose result owns the method path. */
  export: string;
  /** Optional dotted own-property path from the factory result to the method, e.g.
   * `orders.placeOrder`. Dangerous prototype path segments are forbidden by the schema. */
  method?: string;
}

export interface SyntheticExecutionManifestEntry extends SyntheticScenarioDescriptor {
  invoke: SyntheticExecutionInvoke;
}

export interface SyntheticExecutionManifest {
  manifestVersion: typeof SYNTHETIC_MANIFEST_VERSION;
  scenarios: SyntheticExecutionManifestEntry[];
}

const relativeModuleSchema = z.string().trim().min(1).max(2_048).refine((module) => {
  const normalized = module.replaceAll("\\", "/");
  return !normalized.startsWith("/")
    && !/^[A-Za-z]:\//.test(normalized)
    && !normalized.split("/").includes("..")
    && /\.[cm]?tsx?$/.test(normalized);
}, "module must be a project-relative TypeScript file without parent traversal");

const identifierSchema = z.string().regex(/^[A-Za-z_$][A-Za-z0-9_$]*$/).max(256);
const methodPathSchema = z.string().trim().min(1).max(1_024).refine((path) => {
  const segments = path.split(".");
  return segments.every((segment) => identifierSchema.safeParse(segment).success && !forbiddenPathSegments.has(segment));
}, "method must be a dotted safe identifier path");

export const syntheticExecutionInvokeSchema: z.ZodType<SyntheticExecutionInvoke> = z.object({
  module: relativeModuleSchema,
  export: identifierSchema,
  method: methodPathSchema.optional(),
});

export const syntheticExecutionManifestEntrySchema = z.object({
  ...syntheticScenarioDescriptorShape,
  invoke: syntheticExecutionInvokeSchema,
}) satisfies z.ZodType<SyntheticExecutionManifestEntry>;

export const syntheticExecutionManifestSchema: z.ZodType<SyntheticExecutionManifest> = z.object({
  manifestVersion: z.literal(SYNTHETIC_MANIFEST_VERSION),
  scenarios: z.array(syntheticExecutionManifestEntrySchema).max(256),
}).superRefine((manifest, ctx) => {
  const ids = new Set<string>();
  for (const [index, scenario] of manifest.scenarios.entries()) {
    if (ids.has(scenario.id)) {
      ctx.addIssue({ code: "custom", path: ["scenarios", index, "id"], message: "scenario ids must be unique" });
    }
    ids.add(scenario.id);
  }
});

export interface SyntheticNodeSnapshot {
  spanId: string;
  nodeId: string;
  occurrenceKey: string;
  input: JsonValue;
  originalInput?: JsonValue;
  inputOverrideId?: string;
  output?: JsonValue;
  error?: string;
}

export const syntheticNodeSnapshotSchema: z.ZodType<SyntheticNodeSnapshot> = z.object({
  spanId: z.string().regex(/^[0-9a-f]{16}$/i),
  nodeId: nodeIdSchema,
  occurrenceKey: occurrenceKeySchema,
  input: boundedSyntheticJsonValueSchema,
  originalInput: boundedSyntheticJsonValueSchema.optional(),
  inputOverrideId: idSchema.optional(),
  output: boundedSyntheticJsonValueSchema.optional(),
  error: z.string().max(4_096).optional(),
}).refine((snapshot) => !(snapshot.output !== undefined && snapshot.error !== undefined), {
  message: "a snapshot cannot contain both output and error",
}).refine((snapshot) => (snapshot.originalInput === undefined) === (snapshot.inputOverrideId === undefined), {
  message: "an overridden snapshot must identify both its original input and override",
});

export type SyntheticInputOverrideResultStatus = "applied" | "not-reached" | "unsupported";

export interface SyntheticInputOverrideResult {
  id: string;
  target: SyntheticOccurrenceTarget;
  status: SyntheticInputOverrideResultStatus;
  message?: string;
}

export const syntheticInputOverrideResultSchema: z.ZodType<SyntheticInputOverrideResult> = z.object({
  id: idSchema,
  target: syntheticOccurrenceTargetSchema,
  status: z.enum(["applied", "not-reached", "unsupported"]),
  message: descriptionSchema.optional(),
});

export interface SyntheticWatchHit {
  id: string;
  watcherId: string;
  spanId: string;
  nodeId: string;
  occurrenceKey: string;
  phase: SyntheticFieldWatcherPhase;
  path: string[];
  operator: SyntheticFieldWatcherOperator;
  present: boolean;
  value?: JsonValue;
  previousPresent?: boolean;
  previousValue?: JsonValue;
  timeUnixNano: string;
}

export const syntheticWatchHitSchema: z.ZodType<SyntheticWatchHit> = z.object({
  id: idSchema,
  watcherId: idSchema,
  spanId: z.string().regex(/^[0-9a-f]{16}$/i),
  nodeId: nodeIdSchema,
  occurrenceKey: occurrenceKeySchema,
  phase: z.enum(["input", "output"]),
  path: z.array(safePathSegmentSchema).max(64),
  operator: z.enum(["exists", "equals", "changes"]),
  present: z.boolean(),
  value: boundedSyntheticJsonValueSchema.optional(),
  previousPresent: z.boolean().optional(),
  previousValue: boundedSyntheticJsonValueSchema.optional(),
  timeUnixNano: z.string().regex(/^\d+$/).max(20),
}).superRefine((hit, ctx) => {
  if (hit.present !== (hit.value !== undefined)) {
    ctx.addIssue({ code: "custom", path: ["value"], message: "present watch hits must include a value" });
  }
  if (hit.previousPresent !== undefined && hit.previousPresent !== (hit.previousValue !== undefined)) {
    ctx.addIssue({ code: "custom", path: ["previousValue"], message: "previousPresent must match previousValue" });
  }
});

export interface SyntheticExecutionStop {
  reason: "watcher";
  watchHitId: string;
}

export const syntheticExecutionStopSchema: z.ZodType<SyntheticExecutionStop> = z.object({
  reason: z.literal("watcher"),
  watchHitId: idSchema,
});

export interface SyntheticExecution {
  executionVersion: typeof SYNTHETIC_EXECUTION_VERSION;
  scenarioId: string;
  rootId: string;
  generatedAt: string;
  input: JsonValue;
  outcome: "completed" | "stopped";
  output?: JsonValue;
  trace: RequestTrace;
  snapshots: SyntheticNodeSnapshot[];
  inputOverrideResults: SyntheticInputOverrideResult[];
  watchHits: SyntheticWatchHit[];
  stop?: SyntheticExecutionStop;
  warnings: string[];
}

export const syntheticExecutionSchema: z.ZodType<SyntheticExecution> = z.object({
  executionVersion: z.literal(SYNTHETIC_EXECUTION_VERSION),
  scenarioId: idSchema,
  rootId: nodeIdSchema,
  generatedAt: z.string().min(1).max(128),
  input: boundedSyntheticJsonValueSchema,
  outcome: z.enum(["completed", "stopped"]),
  output: boundedSyntheticJsonValueSchema.optional(),
  trace: requestTraceSchema,
  snapshots: z.array(syntheticNodeSnapshotSchema).max(2_000),
  inputOverrideResults: z.array(syntheticInputOverrideResultSchema).max(MAX_INPUT_OVERRIDES),
  watchHits: z.array(syntheticWatchHitSchema).max(MAX_WATCH_HITS),
  stop: syntheticExecutionStopSchema.optional(),
  warnings: z.array(z.string().max(4_096)).max(256),
}).superRefine((execution, ctx) => {
  const root = execution.trace.spans.find((span) => span.spanId === execution.trace.rootSpanId);
  if (root?.nodeId !== execution.rootId) {
    ctx.addIssue({
      code: "custom",
      path: ["trace", "rootSpanId"],
      message: "the trace root span must map to the execution rootId",
    });
  }
  const spans = new Map(execution.trace.spans.map((span) => [span.spanId, span.nodeId]));
  for (const [index, snapshot] of execution.snapshots.entries()) {
    if (spans.get(snapshot.spanId) !== snapshot.nodeId) {
      ctx.addIssue({
        code: "custom",
        path: ["snapshots", index, "spanId"],
        message: "snapshot spanId/nodeId must resolve to the same trace span",
      });
    }
  }
  for (const [index, hit] of execution.watchHits.entries()) {
    if (spans.get(hit.spanId) !== hit.nodeId) {
      ctx.addIssue({
        code: "custom",
        path: ["watchHits", index, "spanId"],
        message: "watch hit spanId/nodeId must resolve to the same trace span",
      });
    }
    const snapshot = execution.snapshots.find((candidate) => candidate.spanId === hit.spanId);
    if (snapshot?.occurrenceKey !== hit.occurrenceKey) {
      ctx.addIssue({
        code: "custom",
        path: ["watchHits", index, "occurrenceKey"],
        message: "watch hit occurrenceKey must resolve to its span snapshot",
      });
    }
  }
  if (execution.outcome === "stopped") {
    if (execution.stop === undefined) {
      ctx.addIssue({ code: "custom", path: ["stop"], message: "stopped executions require a stop reason" });
    } else if (!execution.watchHits.some((hit) => hit.id === execution.stop?.watchHitId)) {
      ctx.addIssue({ code: "custom", path: ["stop", "watchHitId"], message: "stop must reference a watch hit" });
    }
    if (execution.output !== undefined) {
      ctx.addIssue({ code: "custom", path: ["output"], message: "stopped executions cannot have a final output" });
    }
    if (execution.trace.completeness.complete) {
      ctx.addIssue({ code: "custom", path: ["trace", "completeness", "complete"], message: "stopped executions are partial" });
    }
  } else {
    if (execution.stop !== undefined) {
      ctx.addIssue({ code: "custom", path: ["stop"], message: "completed executions cannot have a stop reason" });
    }
    if (execution.watchHits.length > 0) {
      ctx.addIssue({ code: "custom", path: ["watchHits"], message: "a watcher hit must stop the execution" });
    }
  }
});

function validateUniqueRuntimeControls(
  controls: ReadonlyArray<{ id: string; target?: SyntheticOccurrenceTarget }>,
  ctx: z.RefinementCtx,
  uniqueTargets: boolean,
): void {
  const ids = new Set<string>();
  const targets = new Set<string>();
  controls.forEach((control, index) => {
    if (ids.has(control.id)) {
      ctx.addIssue({ code: "custom", path: [index, "id"], message: "runtime control ids must be unique" });
    }
    ids.add(control.id);
    if (!uniqueTargets || control.target === undefined) return;
    const key = `${control.target.nodeId}\u0000${control.target.occurrenceKey}`;
    if (targets.has(key)) {
      ctx.addIssue({ code: "custom", path: [index, "target"], message: "only one input override may target an occurrence" });
    }
    targets.add(key);
  });
}

function syntheticJsonLimitIssue(value: JsonValue): string | null {
  const pending: Array<{ value: JsonValue; depth: number }> = [{ value, depth: 0 }];
  let nodes = 0;
  while (pending.length > 0) {
    const current = pending.pop()!;
    nodes += 1;
    if (nodes > MAX_JSON_NODES) return `JSON values may contain at most ${MAX_JSON_NODES} nodes`;
    if (current.depth > MAX_JSON_DEPTH) return `JSON values may be nested at most ${MAX_JSON_DEPTH} levels`;
    if (Array.isArray(current.value)) {
      current.value.forEach((child) => pending.push({ value: child, depth: current.depth + 1 }));
      continue;
    }
    if (typeof current.value === "object" && current.value !== null) {
      Object.values(current.value).forEach((child) => pending.push({ value: child, depth: current.depth + 1 }));
    }
  }
  return null;
}
