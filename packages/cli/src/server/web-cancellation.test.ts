import { EventEmitter } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import { describe, expect, it } from "vitest";
import {
  isOperationCancelled,
  requestCancellation,
  responseCanWrite,
  throwIfAborted,
} from "./web-cancellation";
import { HttpServiceShutdownError } from "./http-service";

describe("requestCancellation", () => {
  it("aborts only the waiter when the incoming request is aborted", () => {
    const { request, response } = fakeExchange();
    const cancellation = requestCancellation(request, response);

    request.emit("aborted");

    expect(cancellation.signal.aborted).toBe(true);
    expect(isOperationCancelled(cancellation.signal.reason)).toBe(true);
    expect(() => throwIfAborted(cancellation.signal)).toThrow("operation was cancelled");
  });

  it("treats an early response close as cancellation", () => {
    const { request, response, responseState } = fakeExchange();
    const cancellation = requestCancellation(request, response);
    responseState.writableEnded = false;

    response.emit("close");

    expect(cancellation.signal.aborted).toBe(true);
  });

  it("does not retroactively cancel work after a normal response end", () => {
    const { request, response, responseState } = fakeExchange();
    const cancellation = requestCancellation(request, response);
    responseState.writableEnded = true;

    response.emit("close");

    expect(cancellation.signal.aborted).toBe(false);
  });

  it("removes lifecycle listeners when disposed", () => {
    const { request, response } = fakeExchange();
    const cancellation = requestCancellation(request, response);

    cancellation.dispose();
    request.emit("aborted");
    response.emit("close");

    expect(cancellation.signal.aborted).toBe(false);
  });

  it("preserves the service shutdown reason and removes its parent listener", () => {
    const { request, response } = fakeExchange();
    const parent = new AbortController();
    const reason = new HttpServiceShutdownError();
    const cancellation = requestCancellation(request, response, parent.signal);

    parent.abort(reason);

    expect(cancellation.signal.reason).toBe(reason);
    expect(() => throwIfAborted(cancellation.signal)).toThrow(reason);
    cancellation.dispose();
  });
});

describe("responseCanWrite", () => {
  it("requires an open, unfinished response", () => {
    const { response, responseState } = fakeExchange();
    expect(responseCanWrite(response)).toBe(true);
    responseState.destroyed = true;
    expect(responseCanWrite(response)).toBe(false);
    responseState.destroyed = false;
    responseState.writableEnded = true;
    expect(responseCanWrite(response)).toBe(false);
  });
});

function fakeExchange(): {
  request: IncomingMessage;
  response: ServerResponse;
  responseState: { destroyed: boolean; writableEnded: boolean };
} {
  const request = new EventEmitter() as IncomingMessage;
  Object.defineProperty(request, "aborted", { configurable: true, value: false });
  const response = new EventEmitter() as ServerResponse;
  const responseState = { destroyed: false, writableEnded: false };
  Object.defineProperties(response, {
    destroyed: { configurable: true, get: () => responseState.destroyed },
    writableEnded: { configurable: true, get: () => responseState.writableEnded },
  });
  return { request, response, responseState };
}
