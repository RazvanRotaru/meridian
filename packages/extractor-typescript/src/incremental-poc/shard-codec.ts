import {
  graphNodeSchema,
  type ExtractionDiagnostic,
  type FlowAsyncInput,
  type FlowStep,
  type GraphNode,
  type LogicFlows,
  type Port,
} from "@meridian/core";
import type { UnitSummary } from "../cross-package-join";
import type { RawEdge } from "../edge-pass";
import type { UnitExtraction } from "../extract-per-package";
import type { ImplementationMember } from "../implementation-edges";
import { compareCanonicalStrings } from "./canonical-json";

interface SerializedUnitSummary {
  dir: string;
  name: string | null;
  entryFile: string | null;
  sourceDir: string;
  exportsByFile: Array<[string, Array<[string, string]>]>;
  moduleIdByRelPath: Array<[string, string]>;
  pendingReexports: UnitSummary["pendingReexports"];
}

export interface SerializedUnitExtraction {
  nodes: GraphNode[];
  rawEdges: RawEdge[];
  implementationMembers: ImplementationMember[];
  flows: LogicFlows;
  ports: Port[];
  summary: SerializedUnitSummary;
  diagnostics: ExtractionDiagnostic[];
  files: number;
}

export function encodeUnitExtraction(unit: UnitExtraction): SerializedUnitExtraction {
  return jsonSafe({
    nodes: unit.nodes,
    rawEdges: unit.rawEdges,
    implementationMembers: unit.implementationMembers,
    flows: unit.flows,
    ports: unit.ports,
    summary: encodeSummary(unit.summary),
    diagnostics: unit.diagnostics,
    files: unit.files,
  }) as SerializedUnitExtraction;
}

export function decodeUnitExtraction(value: unknown): UnitExtraction {
  if (!isRecord(value)
    || !Array.isArray(value.nodes)
    || !value.nodes.every(isGraphNode)
    || !Array.isArray(value.rawEdges)
    || !value.rawEdges.every(isRawEdge)
    || !Array.isArray(value.implementationMembers)
    || !value.implementationMembers.every(isImplementationMember)
    || !isLogicFlows(value.flows)
    || !Array.isArray(value.ports)
    || !value.ports.every(isPort)
    || !Array.isArray(value.diagnostics)
    || !value.diagnostics.every(isDiagnostic)
    || !Number.isSafeInteger(value.files)
    || (value.files as number) < 0
    || !isRecord(value.summary)) {
    throw new Error("invalid immutable TypeScript unit shard payload");
  }
  return {
    nodes: value.nodes as unknown as GraphNode[],
    rawEdges: value.rawEdges as unknown as RawEdge[],
    implementationMembers: value.implementationMembers as unknown as ImplementationMember[],
    flows: value.flows as unknown as LogicFlows,
    ports: value.ports as unknown as Port[],
    summary: decodeSummary(value.summary),
    diagnostics: value.diagnostics as unknown as ExtractionDiagnostic[],
    files: value.files as number,
  };
}

function encodeSummary(summary: UnitSummary): SerializedUnitSummary {
  return {
    dir: summary.dir,
    name: summary.name,
    entryFile: summary.entryFile,
    sourceDir: summary.sourceDir,
    exportsByFile: [...summary.exportsByFile]
      .sort(([left], [right]) => compareCanonicalStrings(left, right))
      .map(([file, exports]) => [
        file,
        [...exports].sort(([left], [right]) => compareCanonicalStrings(left, right)),
      ]),
    moduleIdByRelPath: [...summary.moduleIdByRelPath]
      .sort(([left], [right]) => compareCanonicalStrings(left, right)),
    pendingReexports: summary.pendingReexports,
  };
}

function decodeSummary(value: Record<string, unknown>): UnitSummary {
  if (typeof value.dir !== "string"
    || (typeof value.name !== "string" && value.name !== null)
    || (typeof value.entryFile !== "string" && value.entryFile !== null)
    || typeof value.sourceDir !== "string"
    || !isStringMapEntries(value.exportsByFile, true)
    || !isStringMapEntries(value.moduleIdByRelPath, false)
    || !Array.isArray(value.pendingReexports)
    || !value.pendingReexports.every(isPendingReexport)) {
    throw new Error("invalid immutable TypeScript unit summary");
  }
  return {
    dir: value.dir,
    name: value.name,
    entryFile: value.entryFile,
    sourceDir: value.sourceDir,
    exportsByFile: new Map(
      value.exportsByFile.map(([file, entries]) => [file, new Map(entries as Array<[string, string]>)])
    ),
    moduleIdByRelPath: new Map(value.moduleIdByRelPath as Array<[string, string]>),
    pendingReexports: value.pendingReexports as UnitSummary["pendingReexports"],
  };
}

function isStringMapEntries(value: unknown, nested: boolean): value is Array<[string, unknown]> {
  return Array.isArray(value) && value.every((entry) => (
    Array.isArray(entry)
    && entry.length === 2
    && typeof entry[0] === "string"
    && (nested ? isStringPairs(entry[1]) : typeof entry[1] === "string")
  ));
}

function isStringPairs(value: unknown): value is Array<[string, string]> {
  return Array.isArray(value) && value.every((entry) => (
    Array.isArray(entry)
    && entry.length === 2
    && typeof entry[0] === "string"
    && typeof entry[1] === "string"
  ));
}

function isGraphNode(value: unknown): value is GraphNode {
  return graphNodeSchema.safeParse(value).success;
}

function isRawEdge(value: unknown): value is RawEdge {
  if (!isRecord(value)
    || typeof value.source !== "string"
    || typeof value.kind !== "string"
    || !isCallSite(value.callSite)
    || !isRecord(value.resolution)) {
    return false;
  }
  const resolution = value.resolution;
  return isResolution(resolution.resolution)
    && isNullableString(resolution.resolvedTarget)
    && isNullableString(resolution.externalModulePath)
    && isNullableString(resolution.externalQualname)
    && typeof resolution.threw === "boolean"
    && (resolution.pending === undefined || isPendingRef(resolution.pending))
    && (resolution.viaModuleFallback === undefined || resolution.viaModuleFallback === true);
}

function isImplementationMember(value: unknown): value is ImplementationMember {
  return isRecord(value)
    && typeof value.id === "string"
    && typeof value.parentId === "string"
    && typeof value.name === "string"
    && typeof value.hasBody === "boolean"
    && typeof value.isStatic === "boolean"
    && (value.shape === null || (
      isRecord(value.shape)
      && isNonNegativeInteger(value.shape.minArgs)
      && (value.shape.maxArgs === null || isNonNegativeInteger(value.shape.maxArgs))
    ))
    && isCallSite(value.callSite);
}

function isLogicFlows(value: unknown): value is LogicFlows {
  return isRecord(value)
    && Object.values(value).every((steps) => (
      Array.isArray(steps) && steps.every(isFlowStep)
    ));
}

function isFlowStep(value: unknown): value is FlowStep {
  if (!isRecord(value)
    || typeof value.kind !== "string"
    || (value.source !== undefined && !isFlowSource(value.source))) {
    return false;
  }
  switch (value.kind) {
    case "call":
      return typeof value.label === "string"
        && isNullableString(value.target)
        && isResolution(value.resolution)
        && isOptionalBoolean(value.awaited)
        && isOptionalBoolean(value.detached)
        && (value.async === undefined || isFlowAsync(value.async));
    case "await":
      return typeof value.label === "string"
        && value.mode === "single"
        && isFlowAsyncInputs(value.inputs);
    case "loop":
    case "callback":
      return typeof value.label === "string"
        && Array.isArray(value.body)
        && value.body.every(isFlowStep);
    case "branch":
      return typeof value.label === "string"
        && (value.branchKind === undefined
          || value.branchKind === "if"
          || value.branchKind === "switch"
          || value.branchKind === "try")
        && Array.isArray(value.paths)
        && value.paths.every(isFlowPath);
    case "exit":
      return (value.variant === "return" || value.variant === "throw")
        && isNullableString(value.label);
    default:
      return false;
  }
}

function isFlowPath(value: unknown): boolean {
  return isRecord(value)
    && typeof value.label === "string"
    && Array.isArray(value.body)
    && value.body.every(isFlowStep)
    && (value.role === undefined
      || ["then", "else", "case", "default", "try", "catch", "finally"].includes(String(value.role)))
    && (value.pathId === undefined || typeof value.pathId === "string")
    && (value.source === undefined || isFlowSource(value.source));
}

function isFlowAsync(value: unknown): boolean {
  if (!isRecord(value) || typeof value.kind !== "string") return false;
  switch (value.kind) {
    case "launch":
      return typeof value.taskId === "string"
        && (value.binding === undefined || typeof value.binding === "string");
    case "direct-await":
      return typeof value.taskId === "string";
    case "barrier":
      return (value.mode === "all" || value.mode === "allSettled")
        && isFlowAsyncInputs(value.inputs);
    default:
      return false;
  }
}

function isFlowAsyncInputs(value: unknown): value is FlowAsyncInput[] {
  return Array.isArray(value) && value.every((input) => (
    isRecord(input)
    && typeof input.label === "string"
    && (input.taskId === undefined || typeof input.taskId === "string")
  ));
}

function isFlowSource(value: unknown): boolean {
  return isRecord(value)
    && typeof value.file === "string"
    && isPositiveInteger(value.line)
    && isOptionalNonNegativeInteger(value.col)
    && isOptionalPositiveInteger(value.endLine)
    && isOptionalNonNegativeInteger(value.endCol);
}

function isPort(value: unknown): value is Port {
  return isRecord(value)
    && typeof value.nodeId === "string"
    && (value.handlerNodeId === undefined || typeof value.handlerNodeId === "string")
    && (value.direction === "in" || value.direction === "out")
    && typeof value.protocol === "string"
    && isNullableString(value.channel)
    && typeof value.label === "string"
    && isCallSite(value.callSite)
    && isOptionalString(value.surfaceId)
    && (value.operation === undefined
      || ["notify", "request", "subscribe", "handle", "respond"].includes(String(value.operation)))
    && isOptionalString(value.lane)
    && isOptionalString(value.scope)
    && (value.scopeKind === undefined || value.scopeKind === "global" || value.scopeKind === "artifact")
    && (value.confidence === undefined
      || (typeof value.confidence === "number"
        && Number.isFinite(value.confidence)
        && value.confidence >= 0
        && value.confidence <= 1));
}

function isDiagnostic(value: unknown): value is ExtractionDiagnostic {
  return isRecord(value)
    && (value.severity === "warn" || value.severity === "error")
    && typeof value.message === "string"
    && isOptionalString(value.nodeId);
}

function isPendingReexport(value: unknown): boolean {
  return isRecord(value)
    && typeof value.file === "string"
    && typeof value.specifier === "string"
    && isOptionalString(value.targetFile)
    && (value.names === null || (
      Array.isArray(value.names)
      && value.names.every((name) => (
        isRecord(name)
        && typeof name.exported === "string"
        && typeof name.local === "string"
      ))
    ));
}

function isPendingRef(value: unknown): boolean {
  return isRecord(value)
    && typeof value.specifier === "string"
    && isNullableString(value.exportedName)
    && isOptionalString(value.targetFile);
}

function isCallSite(value: unknown): boolean {
  return isRecord(value)
    && typeof value.file === "string"
    && isPositiveInteger(value.line)
    && isOptionalNonNegativeInteger(value.col)
    && isOptionalPositiveInteger(value.endLine)
    && isOptionalNonNegativeInteger(value.endCol);
}

function isResolution(value: unknown): value is "resolved" | "external" | "unresolved" {
  return value === "resolved" || value === "external" || value === "unresolved";
}

function isNullableString(value: unknown): value is string | null {
  return typeof value === "string" || value === null;
}

function isOptionalString(value: unknown): boolean {
  return value === undefined || typeof value === "string";
}

function isOptionalBoolean(value: unknown): boolean {
  return value === undefined || typeof value === "boolean";
}

function isNonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function isPositiveInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 1;
}

function isOptionalNonNegativeInteger(value: unknown): boolean {
  return value === undefined || isNonNegativeInteger(value);
}

function isOptionalPositiveInteger(value: unknown): boolean {
  return value === undefined || isPositiveInteger(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/** JSON has no `undefined`; make the immutable codec's omission rule explicit and recursive. */
function jsonSafe(value: unknown, path = "$"): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error(`non-finite shard value at ${path}`);
    return value;
  }
  if (Array.isArray(value)) {
    const keys = Reflect.ownKeys(value);
    if (keys.some((key) => typeof key !== "string" || !isArrayIndex(key, value.length))) {
      throw new Error(`non-index shard array property at ${path}`);
    }
    return Array.from({ length: value.length }, (_, index) => {
      const descriptor = Object.getOwnPropertyDescriptor(value, index);
      if (descriptor === undefined || !("value" in descriptor)) {
        throw new Error(`sparse or accessor shard array value at ${path}[${index}]`);
      }
      if (descriptor.value === undefined) {
        throw new Error(`undefined shard array value at ${path}[${index}]`);
      }
      return jsonSafe(descriptor.value, `${path}[${index}]`);
    });
  }
  if (!isRecord(value)) throw new Error(`non-JSON shard value at ${path}`);
  const ownKeys = Reflect.ownKeys(value);
  if (ownKeys.some((key) => typeof key !== "string")) {
    throw new Error(`symbol shard key at ${path}`);
  }
  const output: Record<string, unknown> = {};
  for (const key of (ownKeys as string[]).sort(compareCanonicalStrings)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) {
      throw new Error(`hidden or accessor shard property at ${path}.${key}`);
    }
    if (descriptor.value !== undefined) {
      output[key] = jsonSafe(descriptor.value, `${path}.${key}`);
    }
  }
  return output;
}

function isArrayIndex(key: string, length: number): boolean {
  if (key === "length") return true;
  const index = Number(key);
  return Number.isSafeInteger(index) && index >= 0 && index < length && String(index) === key;
}
