/**
 * Map an ordered collection without allowing every asynchronous job to be in flight at once.
 * Results retain the input order, matching `Promise.all(items.map(mapper))`, while the bounded
 * worker set caps the transient work and memory owned by the mapper.
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  mapper: (item: T, index: number) => R | PromiseLike<R>,
): Promise<R[]> {
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new RangeError("concurrency must be a positive integer");
  }
  if (items.length === 0) {
    return [];
  }

  const results = new Array<R>(items.length);
  let nextIndex = 0;
  let failed = false;

  const worker = async (): Promise<void> => {
    while (!failed) {
      const index = nextIndex;
      if (index >= items.length) {
        return;
      }
      nextIndex += 1;
      try {
        results[index] = await mapper(items[index], index);
      } catch (error) {
        // Let in-flight jobs finish naturally, but do not launch more expensive work after the
        // result is already known to fail. `Promise.all` below still rejects with the first error.
        failed = true;
        throw error;
      }
    }
  };

  const workerCount = Math.min(concurrency, items.length);
  await Promise.all(Array.from({ length: workerCount }, worker));
  return results;
}
