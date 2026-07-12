/**
 * The GraphArtifact schema as zod — the single runtime source of truth.
 *
 * `safeParse` is the Tier-1 validator; `z.toJSONSchema` (scripts/emit-schema.ts) emits the
 * published JSON Schema from these definitions. Open vocabularies are pattern-validated
 * strings; the only closed enum is `edge.resolution`.
 */

import { z } from "zod";

const NODE_ID = /^[a-z][a-z0-9-]*:[^#\s]+(#[^#\s]+)?(~\d+)?$/;
const LANGUAGE_TAG = /^[a-z][a-z0-9+-]*$/;
const KIND = /^[a-z][a-zA-Z0-9]*$/;
const EDGE_ID = /^[a-zA-Z0-9]+@[^|]+\|.+$/;
const SCHEMA_VERSION = /^1\.\d+\.\d+$/;

export const nodeIdSchema = z.string().regex(NODE_ID);
const languageTagSchema = z.string().regex(LANGUAGE_TAG);
const kindSchema = z.string().regex(KIND);

export const generatorSchema = z.object({
  name: z.string(),
  version: z.string(),
});

const vcsSchema = z.object({
  repository: z.string().optional(),
  commit: z.string().optional(),
  branch: z.string().optional(),
  dirty: z.boolean().optional(),
});

export const targetSchema = z.object({
  name: z.string(),
  version: z.string().optional(),
  root: z.string(),
  language: languageTagSchema,
  vcs: vcsSchema.optional(),
});

export const telemetryContractSchema = z.object({
  joinKey: z.literal("node.id"),
  requiredRuntimeAttributes: z.array(z.string()),
  serviceDefaulting: z.literal("forbidden"),
  semconvVersion: z.string().optional(),
});

const sourceLocationSchema = z.object({
  file: z.string(),
  startLine: z.number().int().min(1),
  endLine: z.number().int().min(1).optional(),
  startCol: z.number().int().min(0).optional(),
});

const telemetryKeySchema = z.object({
  codeNamespace: z.string().nullable().optional(),
  codeFunction: z.string(),
  spanNameHints: z.array(z.string()).min(1),
});

export const graphNodeSchema = z.object({
  id: nodeIdSchema,
  kind: kindSchema,
  qualifiedName: z.string(),
  displayName: z.string(),
  summary: z.string().nullable().optional(),
  parentId: nodeIdSchema.nullable().optional(),
  language: languageTagSchema.optional(),
  location: sourceLocationSchema,
  signature: z.string().optional(),
  tags: z.array(z.string()).optional(),
  telemetry: telemetryKeySchema.optional(),
});

const callSiteSchema = z.object({
  file: z.string(),
  line: z.number().int().min(1),
  col: z.number().int().min(0).optional(),
  endLine: z.number().int().min(1).optional(),
  endCol: z.number().int().min(0).optional(),
});

export const graphEdgeSchema = z.object({
  id: z.string().regex(EDGE_ID),
  source: nodeIdSchema,
  target: nodeIdSchema,
  kind: kindSchema,
  resolution: z.enum(["resolved", "external", "unresolved"]).optional(),
  weight: z.number().int().min(1).optional(),
  callSites: z.array(callSiteSchema).optional(),
  confidence: z.number().min(0).max(1).optional(),
});

export const graphArtifactSchema = z.object({
  schemaVersion: z.string().regex(SCHEMA_VERSION),
  generatedAt: z.string(),
  generator: generatorSchema,
  target: targetSchema,
  telemetry: telemetryContractSchema.optional(),
  nodes: z.array(graphNodeSchema),
  edges: z.array(graphEdgeSchema),
  extensions: z.record(z.string(), z.unknown()).optional(),
});
