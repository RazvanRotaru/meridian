/**
 * One request's AppMap-like execution timeline.
 *
 * Timed work is represented as OTel-shaped spans; cheap point observations such as branch
 * decisions and safe values are span events. `nodeId` remains the exact graph join key.
 */

import { z } from "zod";
import { nodeIdSchema } from "./schema";
import { telemetryEnvironmentSchema, telemetryProducerKindSchema } from "./telemetry-source";
import { MAX_EVENTS_PER_TRACE, validateRequestTrace } from "./trace-validation";

export const TRACE_VERSION = "1.0.0" as const;

const TRACE_ID = /^[0-9a-f]{32}$/i;
const SPAN_ID = /^[0-9a-f]{16}$/i;
const UINT64_MAX = 18_446_744_073_709_551_615n;
const MAX_TEXT = 4_096;
const MAX_ID = 512;
const MAX_ATTRIBUTES = 128;
const MAX_ATTRIBUTE_ARRAY = 128;
const MAX_SPANS = 2_000;

const textSchema = z.string().max(MAX_TEXT);
const idSchema = z.string().min(1).max(MAX_ID);
export const traceIdSchema = z.string().regex(TRACE_ID).refine((id) => !/^0+$/.test(id), "trace id must be non-zero");
export const spanIdSchema = z.string().regex(SPAN_ID).refine((id) => !/^0+$/.test(id), "span id must be non-zero");
export const unixNanoSchema = z.string().refine(isUint64, "nanoseconds must be a uint64 decimal string");

export const traceAttributeScalarSchema = z.union([textSchema, z.number().finite(), z.boolean()]);
export const traceAttributeValueSchema = z.union([
  traceAttributeScalarSchema,
  z.array(textSchema).max(MAX_ATTRIBUTE_ARRAY),
  z.array(z.number().finite()).max(MAX_ATTRIBUTE_ARRAY),
  z.array(z.boolean()).max(MAX_ATTRIBUTE_ARRAY),
]);
export const traceAttributesSchema = z.record(z.string().min(1).max(256), traceAttributeValueSchema)
  .refine((attributes) => attributes !== null && Object.keys(attributes).length <= MAX_ATTRIBUTES, `at most ${MAX_ATTRIBUTES} attributes are allowed`);

export type TraceAttributeScalar = z.infer<typeof traceAttributeScalarSchema>;
export type TraceAttributeValue = z.infer<typeof traceAttributeValueSchema>;
export type TraceAttributes = z.infer<typeof traceAttributesSchema>;

export const traceSourceSchema = z.object({
  file: z.string().min(1).max(2_048),
  line: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
  col: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(),
});

export type TraceSource = z.infer<typeof traceSourceSchema>;

const eventFields = {
  eventId: idSchema,
  timeUnixNano: unixNanoSchema,
  attributes: traceAttributesSchema,
};

export const branchTakenEventSchema = z.object({
  type: z.literal("branch.taken"),
  ...eventFields,
  siteId: idSchema,
  pathId: idSchema,
  condition: textSchema,
  outcome: traceAttributeScalarSchema,
  source: traceSourceSchema,
  value: traceAttributeValueSchema.optional(),
  valueName: idSchema.optional(),
});

export const dataObserveEventSchema = z.object({
  type: z.literal("data.observe"),
  ...eventFields,
  siteId: idSchema.optional(),
  name: idSchema,
  valueId: idSchema,
  value: traceAttributeValueSchema,
  derivedFrom: z.array(idSchema).max(MAX_ATTRIBUTE_ARRAY).optional(),
  source: traceSourceSchema.optional(),
});

export const loopSummaryEventSchema = z.object({
  type: z.literal("loop.summary"),
  ...eventFields,
  siteId: idSchema,
  label: textSchema.min(1),
  iterations: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  emittedIterations: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  truncated: z.boolean(),
  source: traceSourceSchema,
});

export const exceptionEventSchema = z.object({
  type: z.literal("exception"),
  ...eventFields,
  siteId: idSchema.optional(),
  exceptionType: idSchema,
  message: textSchema.optional(),
  handled: z.boolean(),
  source: traceSourceSchema.optional(),
});

export const asyncHandoffEventSchema = z.object({
  type: z.literal("async.handoff"),
  ...eventFields,
  mode: z.enum(["awaited", "detached", "callback"]),
  siteId: idSchema,
  source: traceSourceSchema,
  targetSpanId: spanIdSchema.optional(),
});

export const timelineEventSchema = z.discriminatedUnion("type", [
  branchTakenEventSchema,
  dataObserveEventSchema,
  loopSummaryEventSchema,
  exceptionEventSchema,
  asyncHandoffEventSchema,
]);

export type BranchTakenEvent = z.infer<typeof branchTakenEventSchema>;
export type DataObserveEvent = z.infer<typeof dataObserveEventSchema>;
export type LoopSummaryEvent = z.infer<typeof loopSummaryEventSchema>;
export type ExceptionTimelineEvent = z.infer<typeof exceptionEventSchema>;
export type AsyncHandoffEvent = z.infer<typeof asyncHandoffEventSchema>;
export type TimelineEvent = z.infer<typeof timelineEventSchema>;

export const timelineSpanLinkSchema = z.object({
  traceId: traceIdSchema,
  spanId: spanIdSchema,
  relation: z.enum(["async", "message", "detached"]),
  attributes: traceAttributesSchema,
});

export const timelineSpanSchema = z.object({
  spanId: spanIdSchema,
  parentSpanId: spanIdSchema.optional(),
  nodeId: nodeIdSchema.max(2_048).optional(),
  name: textSchema.min(1),
  kind: z.enum(["internal", "server", "client", "producer", "consumer"]),
  startedAtUnixNano: unixNanoSchema,
  endedAtUnixNano: unixNanoSchema,
  status: z.enum(["unset", "ok", "error"]),
  attributes: traceAttributesSchema,
  links: z.array(timelineSpanLinkSchema).max(MAX_ATTRIBUTE_ARRAY).optional(),
  events: z.array(timelineEventSchema).max(MAX_EVENTS_PER_TRACE),
});

export type TimelineSpanLink = z.infer<typeof timelineSpanLinkSchema>;
export type TimelineSpan = z.infer<typeof timelineSpanSchema>;

export const traceCompletenessSchema = z.object({
  complete: z.boolean(),
  droppedSpans: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  droppedEvents: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  droppedValues: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
});

const requestTraceShapeSchema = z.object({
  traceId: traceIdSchema,
  name: textSchema.min(1),
  rootSpanId: spanIdSchema,
  startedAtUnixNano: unixNanoSchema,
  endedAtUnixNano: unixNanoSchema,
  status: z.enum(["unset", "ok", "error"]),
  attributes: traceAttributesSchema,
  spans: z.array(timelineSpanSchema).max(MAX_SPANS),
  completeness: traceCompletenessSchema,
});

export type TraceCompleteness = z.infer<typeof traceCompletenessSchema>;
export type RequestTrace = z.infer<typeof requestTraceShapeSchema>;
export const requestTraceSchema = requestTraceShapeSchema.superRefine(validateRequestTrace);

export const traceGraphRefSchema = z.object({
  schemaVersion: z.string().min(1).max(64),
  generatedAt: z.string().min(1).max(128),
  nodeCount: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  commit: idSchema.optional(),
});

const traceBundleShapeSchema = z.object({
  traceVersion: z.literal(TRACE_VERSION),
  source: telemetryProducerKindSchema,
  env: telemetryEnvironmentSchema,
  generatedAt: z.string().min(1).max(128),
  graphRef: traceGraphRefSchema,
  traces: z.array(requestTraceSchema).max(MAX_SPANS),
});

export type TraceGraphRef = z.infer<typeof traceGraphRefSchema>;
export type TraceBundle = z.infer<typeof traceBundleShapeSchema>;
export const traceBundleSchema = traceBundleShapeSchema.superRefine((bundle, ctx) => {
  const traceIds = new Set<string>();
  for (const [index, trace] of bundle.traces.entries()) {
    if (traceIds.has(trace.traceId)) {
      ctx.addIssue({
        code: "custom",
        path: ["traces", index, "traceId"],
        message: "trace ids must be unique within a bundle",
      });
    } else {
      traceIds.add(trace.traceId);
    }
  }
});

function isUint64(value: string): boolean {
  return value.length <= 20 && /^\d+$/.test(value) && BigInt(value) <= UINT64_MAX;
}
