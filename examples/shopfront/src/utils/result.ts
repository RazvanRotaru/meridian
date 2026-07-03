/**
 * A minimal Result type so services can fail without throwing. A handful of handlers unwrap
 * these, which threads a few more edges through the graph.
 */

/** A successful result carrying a value. */
export interface Ok<T> {
  ok: true;
  value: T;
}

/** A failed result carrying an error message. */
export interface Err {
  ok: false;
  error: string;
}

/** Either an Ok<T> or an Err. */
export type Result<T> = Ok<T> | Err;

/** Wrap a value as a successful result. */
export function ok<T>(value: T): Result<T> {
  return { ok: true, value };
}

/** Wrap a message as a failed result. */
export function err(error: string): Result<never> {
  return { ok: false, error };
}

/** Narrowing helper: whether a result succeeded. */
export function isOk<T>(result: Result<T>): result is Ok<T> {
  return result.ok;
}

/** Get the value or a fallback, without throwing. */
export function unwrapOr<T>(result: Result<T>, fallback: T): T {
  return isOk(result) ? result.value : fallback;
}
