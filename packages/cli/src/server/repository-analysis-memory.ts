import { totalmem } from "node:os";

const DEFAULT_WORKER_HEAP_MB = 8_192;
const MAX_AUTOMATIC_CONCURRENT_ANALYSES = 2;
const MIN_WORKER_HEAP_MB = 1_024;
const MAX_WORKER_HEAP_MB = 131_072;
const PARENT_MEMORY_RESERVE_MB = 2_048;
const MIN_WORKER_OVERHEAD_MB = 1_024;
const WORKER_OVERHEAD_RATIO = 0.25;
const MEBIBYTE_BYTES = 1_024 ** 2;

export interface RepositoryAnalysisMemorySnapshot {
  totalBytes: number;
  constrainedBytes?: number;
}

export interface RepositoryAnalysisMemoryPolicy {
  maxConcurrentAnalyses: number;
  workerHeapMb: number;
}

export interface RepositoryAnalysisMemoryPolicyOptions {
  maxConcurrentAnalyses?: number;
  memory?: RepositoryAnalysisMemorySnapshot;
  workerHeapMb?: number;
}

/** Resolve the worker heap used by both child startup and admission accounting. */
export function repositoryAnalysisWorkerHeapMb(
  environment: NodeJS.ProcessEnv = process.env,
): number {
  const configuredRaw = environment.MERIDIAN_REPOSITORY_ANALYSIS_WORKER_HEAP_MB;
  if (configuredRaw !== undefined) {
    const configured = exactHeapMb(configuredRaw);
    if (configured === undefined) {
      throw new RangeError(
        "MERIDIAN_REPOSITORY_ANALYSIS_WORKER_HEAP_MB must be between 1024 and 131072 MiB",
      );
    }
    return configured;
  }
  const pinned = pinnedNodeHeapMb(environment.NODE_OPTIONS);
  return pinned ?? DEFAULT_WORKER_HEAP_MB;
}

/** Produce the enforced child-process heap flag from an already resolved policy. */
export function repositoryAnalysisWorkerHeapArg(workerHeapMb?: number): string {
  const resolved = workerHeapMb ?? repositoryAnalysisWorkerHeapMb();
  if (!validHeapMb(resolved)) {
    throw new RangeError("repository analysis worker heap must be between 1024 and 131072 MiB");
  }
  return `--max-old-space-size=${resolved}`;
}

/**
 * Resolve one immutable startup policy for memory-heavy repository workers.
 *
 * A slot reserves the worker's V8 old-space plus native/external overhead. Two GiB remains for
 * the parent and OS. At least one slot is always admitted so constrained machines still work.
 */
export function repositoryAnalysisMemoryPolicy(
  options: RepositoryAnalysisMemoryPolicyOptions = {},
): RepositoryAnalysisMemoryPolicy {
  const configuredCap = options.maxConcurrentAnalyses === undefined
    ? MAX_AUTOMATIC_CONCURRENT_ANALYSES
    : positiveInteger(options.maxConcurrentAnalyses, "maxConcurrentAnalyses");
  const workerHeapMb = options.workerHeapMb ?? repositoryAnalysisWorkerHeapMb();
  if (!validHeapMb(workerHeapMb)) {
    throw new RangeError("repository analysis worker heap must be between 1024 and 131072 MiB");
  }
  const memory = options.memory ?? systemMemorySnapshot();
  const effectiveBytes = effectiveMemoryBytes(memory);
  const workerOverheadMb = Math.max(
    MIN_WORKER_OVERHEAD_MB,
    Math.ceil(workerHeapMb * WORKER_OVERHEAD_RATIO),
  );
  const slotBytes = (workerHeapMb + workerOverheadMb) * MEBIBYTE_BYTES;
  const budgetBytes = Math.max(0, effectiveBytes - PARENT_MEMORY_RESERVE_MB * MEBIBYTE_BYTES);
  const memorySlots = Math.max(1, Math.floor(budgetBytes / slotBytes));
  return {
    maxConcurrentAnalyses: Math.min(
      MAX_AUTOMATIC_CONCURRENT_ANALYSES,
      configuredCap,
      memorySlots,
    ),
    workerHeapMb,
  };
}

function systemMemorySnapshot(): RepositoryAnalysisMemorySnapshot {
  return {
    totalBytes: totalmem(),
    constrainedBytes: process.constrainedMemory(),
  };
}

function effectiveMemoryBytes(memory: RepositoryAnalysisMemorySnapshot): number {
  if (!validMemoryBytes(memory.totalBytes)) {
    throw new RangeError("total memory must be a positive safe integer");
  }
  const constrained = memory.constrainedBytes;
  if (constrained === undefined || constrained === 0) return memory.totalBytes;
  if (!validMemoryBytes(constrained)) {
    throw new RangeError("constrained memory must be zero or a positive safe integer");
  }
  return Math.min(memory.totalBytes, constrained);
}

function validMemoryBytes(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}

function validHeapMb(value: number): boolean {
  return Number.isSafeInteger(value) && value >= MIN_WORKER_HEAP_MB && value <= MAX_WORKER_HEAP_MB;
}

function pinnedNodeHeapMb(nodeOptions: string | undefined): number | undefined {
  if (!nodeOptions) return undefined;
  const matches = [
    ...nodeOptions.matchAll(/(?:^|\s)--max[-_]old[-_]space[-_]size(?:=|\s+)(\d+)(?=\s|$)/g),
  ];
  return exactHeapMb(matches.at(-1)?.[1]);
}

function exactHeapMb(raw: string | undefined): number | undefined {
  const value = raw?.trim();
  if (!value || !/^\d+$/.test(value)) return undefined;
  const parsed = Number(value);
  return validHeapMb(parsed) ? parsed : undefined;
}

function positiveInteger(value: number, label: string): number {
  if (!Number.isInteger(value) || value < 1) {
    throw new RangeError(`${label} must be a positive integer`);
  }
  return value;
}
