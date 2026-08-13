/**
 * The bare-import shape from real protocol code: the ONLY uses of `./wire` are a named type alias in
 * an augmentation (owned by the ordinary type pass) and a plain-const read (no emitted node →
 * invisible to the value path without the module fallback).
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

type CallbackOptions = {
    callback(input: string): string | undefined;
};

declare class CallbackConsumer {
    constructor(options: CallbackOptions);
}

export function localCallback(input: string): string | undefined {
    return input === "skip" ? undefined : input;
}

export function createConsumer(): unknown {
    return new CallbackConsumer({ callback: (localCallback as CallbackOptions["callback"]) });
}

export function exposeCallback(): (input: string) => string | undefined {
    return localCallback;
}

export function invokeCallback(input: string): string | undefined {
    return localCallback(input);
}
