import { describe, expect, it } from "vitest";
import { boundedJsonChunks, jsonEncodedByteLength } from "./bounded-json";

describe("bounded JSON encoding", () => {
  it("matches native JSON for nested values, escapes, and malformed surrogate input", () => {
    const value = {
      text: "quote=\" slash=\\ control=\n emoji=🚀 lone=\ud800",
      numbers: [0, -0, 1.25, Number.NaN, Number.POSITIVE_INFINITY],
      omitted: undefined,
      array: [undefined, true, null],
    };
    const expected = JSON.stringify(value);
    const chunks = [...boundedJsonChunks(value, 16 * 1024)];

    expect(chunks.join("")).toBe(expected);
    expect(jsonEncodedByteLength(value)).toBe(Buffer.byteLength(expected));
  });

  it("never emits a response-sized chunk for a large string", () => {
    const maxChunkBytes = 64 * 1024;
    const value = { payload: "🚀x".repeat(2 * 1024 * 1024) };
    const chunks = [...boundedJsonChunks(value, maxChunkBytes)];

    expect(chunks.length).toBeGreaterThan(100);
    expect(Math.max(...chunks.map((chunk) => Buffer.byteLength(chunk)))).toBeLessThanOrEqual(maxChunkBytes);
    expect(chunks.join("")).toBe(JSON.stringify(value));
    expect(jsonEncodedByteLength(value)).toBe(Buffer.byteLength(JSON.stringify(value)));
  });

  it("fails closed on stateful object serializers", () => {
    const value = { generatedAt: new Date("2026-07-17T00:00:00.000Z") };
    expect(() => jsonEncodedByteLength(value)).toThrow(/plain objects/);
    expect(() => [...boundedJsonChunks(value, 64 * 1024)]).toThrow(/plain objects/);
  });
});
