/**
 * The same-origin guard that protects the `/api/*` surface from a malicious page in the same
 * browser. A missing Origin (same-origin GETs omit it) is trusted; a present one must match the
 * Host header exactly, which is why the check survives the server's port walking forward.
 */

import { describe, expect, it } from "vitest";
import type { IncomingMessage } from "node:http";
import { assertJsonContentType, assertSameOrigin, isSameOrigin } from "./web-guards";
import { WebError } from "./web-error";

function request(headers: Record<string, string>): IncomingMessage {
  return { headers } as unknown as IncomingMessage;
}

describe("isSameOrigin", () => {
  it("trusts a request with no Origin header", () => {
    expect(isSameOrigin(undefined, "127.0.0.1:4180")).toBe(true);
  });

  it("accepts an Origin whose host matches, on any port", () => {
    expect(isSameOrigin("http://127.0.0.1:4180", "127.0.0.1:4180")).toBe(true);
    expect(isSameOrigin("http://127.0.0.1:4199", "127.0.0.1:4199")).toBe(true);
  });

  it("rejects a foreign Origin or a malformed one", () => {
    expect(isSameOrigin("http://evil.example", "127.0.0.1:4180")).toBe(false);
    expect(isSameOrigin("not a url", "127.0.0.1:4180")).toBe(false);
  });
});

describe("assertSameOrigin", () => {
  it("throws on a cross-origin request and passes a same-origin one", () => {
    expect(() => assertSameOrigin(request({ origin: "http://evil.example", host: "127.0.0.1:4180" }))).toThrow(WebError);
    expect(() => assertSameOrigin(request({ host: "127.0.0.1:4180" }))).not.toThrow();
  });
});

describe("assertJsonContentType", () => {
  it("requires an application/json content type", () => {
    expect(() => assertJsonContentType(request({ "content-type": "text/plain" }))).toThrow(WebError);
    expect(() => assertJsonContentType(request({ "content-type": "application/json; charset=utf-8" }))).not.toThrow();
  });
});
