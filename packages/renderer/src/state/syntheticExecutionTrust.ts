/**
 * Server-authored execution trust boundary. This describes where code will run; it is not a
 * user preference and must never be inferred from the currently selected GitHub surface.
 */
export type SyntheticExecutionTrust = {
  mode: "local";
  provenance?: {
    repository?: string;
    headSha?: string;
  };
} | {
  mode: "sandboxed-pr";
  /** Immutable identity is mandatory before the renderer can ask for untrusted-code consent. */
  provenance: {
    repository: string;
    headSha: string;
  };
};
