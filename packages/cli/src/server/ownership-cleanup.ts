export type CleanupOperation = () => unknown | Promise<unknown>;

/**
 * A primary ownership operation failed and one or more ordered cleanup operations also failed.
 * `errors` preserves the primary failure first, including falsy thrown values, followed by every
 * cleanup failure in declaration order. Nested ownership-cleanup failures are flattened so callers
 * receive one complete ownership-failure record.
 */
export class OwnershipCleanupError extends AggregateError {
  constructor(errors: readonly unknown[], label: string) {
    super(errors, `${label} and ownership cleanup failed`);
    this.name = "OwnershipCleanupError";
  }
}

/**
 * Run an operation and then every ownership cleanup in declaration order. Cleanup is never
 * best-effort: the primary failure (including falsy thrown values) remains first, while every
 * release failure is retained in the resulting AggregateError.
 */
export async function withOwnershipCleanup<T>(
  operation: () => T | Promise<T>,
  cleanups: readonly CleanupOperation[],
  label: string,
): Promise<T> {
  let value!: T;
  let operationFailed = false;
  let operationError: unknown;
  try {
    value = await operation();
  } catch (error) {
    operationFailed = true;
    operationError = error;
  }

  const errors: unknown[] = operationFailed
    ? operationError instanceof OwnershipCleanupError
      ? [...operationError.errors]
      : [operationError]
    : [];
  let cleanupFailed = false;
  for (const cleanup of cleanups) {
    try {
      await cleanup();
    } catch (error) {
      cleanupFailed = true;
      if (error instanceof OwnershipCleanupError) errors.push(...error.errors);
      else errors.push(error);
    }
  }
  if (cleanupFailed) throw new OwnershipCleanupError(errors, label);
  if (operationFailed) throw operationError;
  return value;
}
