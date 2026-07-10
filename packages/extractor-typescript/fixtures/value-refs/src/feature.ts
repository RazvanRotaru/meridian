/**
 * The bare-import shape from real protocol code: the ONLY uses of `./wire` are a type alias in an
 * augmentation (no emitted node → invisible to the type pass) and a plain-const read (no emitted
 * node → invisible to the value path without the module fallback).
 */
import type { VoidRequest } from './wire';
import { RETRY_LIMIT } from './wire';

declare module './wire' {
    interface EventMap {
        ping: { request: VoidRequest; result: string };
        pong: { request: VoidRequest; result: number };
    }
}

export function retriesLeft(attempt: number): number {
    return RETRY_LIMIT - attempt;
}
