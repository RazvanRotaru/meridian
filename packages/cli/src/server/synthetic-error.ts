/** HTTP-safe failures from the synthetic execution boundary. */

export type SyntheticExecutionErrorCode =
  | "invalid-manifest"
  | "invalid-request"
  | "scenario-not-found"
  | "unsupported-runtime"
  | "unsupported-scenario"
  | "compile-failed"
  | "execution-failed"
  | "invalid-result";

/** Compiler paths, child stderr, and source text must never cross this error boundary. */
export class SyntheticExecutionError extends Error {
  constructor(
    readonly code: SyntheticExecutionErrorCode,
    readonly status: 400 | 404 | 409 | 422 | 500,
    message: string,
  ) {
    super(message);
    this.name = "SyntheticExecutionError";
  }
}
