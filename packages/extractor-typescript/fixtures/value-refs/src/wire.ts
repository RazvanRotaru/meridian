/** A protocol-style module: a type alias (never emitted as a node) plus an augmentable map. */
export type VoidRequest = Record<string, never>;

export interface EventMap {}

export const RETRY_LIMIT = 3;
