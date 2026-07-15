/** Pure memory-aware admission policy for extraction workers. */

/** Native parent allocations, Git helpers, and OS safety margin beyond the charged parent heap. */
export const INSPECTION_SERVER_RESERVE_MB = 2_048;
/**
 * Charged long-lived parent budget. Projection readers, descriptors, active responses, and
 * scheduler state are bounded well below this value; the 8 GiB process ceiling exists for CLI
 * extraction compatibility and must not be mistaken for resident server memory.
 */
export const INSPECTION_PARENT_HEAP_BUDGET_MB = 1_024;
export const INSPECTION_WORKER_OVERHEAD_MB = 1_024;
export const DEFAULT_INSPECTION_CONCURRENCY = 2;

export interface InspectionCapacityInputs {
  readonly totalMemoryMb: number;
  readonly availableMemoryMb?: number;
  /** Actual V8 heap ceiling of the long-lived web parent, not merely its current RSS. */
  readonly parentHeapMb: number;
  readonly workerHeapMb: number;
  readonly requestedConcurrency?: string | number;
  readonly memoryBudgetMb?: string | number;
}

/**
 * Preserve one guaranteed execution slot, and admit more only after reserving the long-lived parent's
 * bounded charged heap plus native/Git/OS headroom. Each worker then consumes its own JS heap plus
 * a native/Python allowance. The parent process may have a larger V8 ceiling, but the stateless
 * projection architecture does not reserve memory merely because V8 could allocate it. An
 * explicit budget makes container deployments deterministic;
 * otherwise the tighter of physical and currently available memory wins.
 */
export function resolveInspectionConcurrency(inputs: InspectionCapacityInputs): number {
  const requested = positiveInteger(inputs.requestedConcurrency) ?? DEFAULT_INSPECTION_CONCURRENCY;
  const explicitBudget = positiveInteger(inputs.memoryBudgetMb);
  const physical = finitePositive(inputs.totalMemoryMb);
  const available = finitePositive(inputs.availableMemoryMb);
  const detectedBudget = available === undefined ? physical : Math.min(physical, available);
  const budget = explicitBudget ?? detectedBudget;
  const parentFootprint = Math.min(
    finitePositive(inputs.parentHeapMb),
    INSPECTION_PARENT_HEAP_BUDGET_MB,
  ) + INSPECTION_SERVER_RESERVE_MB;
  const workerFootprint = inputs.workerHeapMb + INSPECTION_WORKER_OVERHEAD_MB;
  const memoryBound = Math.max(1, Math.floor(Math.max(0, budget - parentFootprint) / workerFootprint));
  return Math.max(1, Math.min(requested, memoryBound));
}

function positiveInteger(value: string | number | undefined): number | undefined {
  const parsed = typeof value === "number" ? value : Number.parseInt(value ?? "", 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function finitePositive(value: number | undefined): number {
  return Number.isFinite(value) && (value ?? 0) > 0 ? value! : Number.POSITIVE_INFINITY;
}
