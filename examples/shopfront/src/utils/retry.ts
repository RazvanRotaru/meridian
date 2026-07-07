/**
 * Retry, extracted from utils/legacy. Only payments uses it today; it no longer drags the
 * whole grab-bag into the payment path.
 */

import { clamp } from "./numbers.js";

/** Retry a synchronous thunk a few times, swallowing failures until the last. */
export function retry<T>(attempts: number, thunk: () => T): T {
  let lastError: unknown;
  for (let index = 0; index < clamp(attempts, 1, 5); index += 1) {
    try {
      return thunk();
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}
