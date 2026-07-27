import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { canonicalJson, canonicalJsonSha256 } from "./canonical-json";

describe("canonicalJson", () => {
  it("sorts every object while preserving array order", () => {
    const value = {
      z: [3, { second: true, first: false }],
      a: { z: null, a: "text" },
    };
    expect(canonicalJson(value)).toBe(
      "{\"a\":{\"a\":\"text\",\"z\":null},\"z\":[3,{\"first\":false,\"second\":true}]}",
    );
  });

  it("hashes the exact UTF-8 canonical representation", () => {
    const value = { revision: "tree", inputs: [2, 1] };
    const expected = createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
    expect(canonicalJsonSha256(value)).toBe(expected);
  });

  it("allows repeated acyclic references", () => {
    const shared = { value: 1 };
    expect(canonicalJson({ left: shared, right: shared })).toBe(
      "{\"left\":{\"value\":1},\"right\":{\"value\":1}}",
    );
  });

  it("rejects values that do not have an unambiguous JSON representation", () => {
    const cyclic: { self?: unknown } = {};
    cyclic.self = cyclic;
    const accessor = [1];
    Object.defineProperty(accessor, "0", { enumerable: true, get: () => 1 });

    expect(() => canonicalJson({ missing: undefined })).toThrow(/undefined/);
    expect(() => canonicalJson([Number.NaN])).toThrow(/non-finite/);
    expect(() => canonicalJson(new Date(0))).toThrow(/non-plain/);
    expect(() => canonicalJson(cyclic)).toThrow(/cycle/);
    expect(() => canonicalJson(new Array(1))).toThrow(/sparse/);
    expect(() => canonicalJson(accessor)).toThrow(/accessor/);
  });
});
