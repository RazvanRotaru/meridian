import { getEventListeners } from "node:events";
import type { IncomingMessage } from "node:http";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { artifactId, parseGenerateRequest, readJsonBody } from "./web-request";

describe("web graph identity", () => {
  it("rejects retired and unknown selectors instead of retaining a compatibility path", () => {
    expect(() => parseGenerateRequest({ kind: "path", value: "/repo", lang: "typescript" }))
      .toThrow(/unknown field/);
    const request = parseGenerateRequest({ kind: "path", value: "/repo" });
    expect(artifactId(request)).toBe(artifactId({ kind: "path", value: "/repo" }));
  });
});

describe("readJsonBody", () => {
  it("parses a body and removes every terminal listener", async () => {
    const request = requestStream();
    const lifecycle = new AbortController();
    const pending = readJsonBody({ request, signal: lifecycle.signal });

    request.end('{"ok":true}');

    await expect(pending).resolves.toEqual({ ok: true });
    expectBodyListenersRemoved(request, lifecycle.signal);
  });

  it("rejects a pre-aborted lifecycle without starting body consumption", async () => {
    const request = requestStream();
    const lifecycle = new AbortController();
    const reason = new Error("server closing");
    lifecycle.abort(reason);

    const rejected = await readJsonBody({ request, signal: lifecycle.signal }).catch((error) => error);

    expect(rejected).toBe(reason);
    expect(request.destroyed).toBe(true);
    expectBodyListenersRemoved(request, lifecycle.signal);
  });

  it("cancels and destroys a partial body exactly once on lifecycle shutdown", async () => {
    const request = requestStream();
    const lifecycle = new AbortController();
    const reason = new Error("server closing");
    const pending = readJsonBody({ request, signal: lifecycle.signal });
    request.write("{");

    lifecycle.abort(reason);
    request.emit("aborted");

    expect(await pending.catch((error) => error)).toBe(reason);
    expect(request.destroyed).toBe(true);
    expectBodyListenersRemoved(request, lifecycle.signal);
  });

  it("rejects a client-aborted partial body and detaches the lifecycle", async () => {
    const request = requestStream();
    const lifecycle = new AbortController();
    const pending = readJsonBody({ request, signal: lifecycle.signal });
    request.write("{");

    request.emit("aborted");

    await expect(pending).rejects.toMatchObject({ status: 400, message: "client closed request body" });
    lifecycle.abort(new Error("late shutdown"));
    expectBodyListenersRemoved(request, lifecycle.signal);
  });

  it("destroys an over-limit stream and rejects with HTTP 413", async () => {
    const request = requestStream();
    const lifecycle = new AbortController();
    const pending = readJsonBody({ request, signal: lifecycle.signal, maxBytes: 4 });

    request.end("12345");

    await expect(pending).rejects.toMatchObject({ status: 413, message: "request body too large" });
    expect(request.destroyed).toBe(true);
    expectBodyListenersRemoved(request, lifecycle.signal);
  });
});

function requestStream(): IncomingMessage & PassThrough {
  const stream = new PassThrough();
  Object.defineProperties(stream, {
    aborted: { configurable: true, value: false, writable: true },
    complete: { configurable: true, value: false, writable: true },
  });
  return stream as unknown as IncomingMessage & PassThrough;
}

function expectBodyListenersRemoved(request: IncomingMessage, signal: AbortSignal): void {
  for (const event of ["data", "end", "error", "aborted", "close"]) {
    expect(request.listenerCount(event), `${event} listener`).toBe(0);
  }
  expect(getEventListeners(signal, "abort")).toHaveLength(0);
}
