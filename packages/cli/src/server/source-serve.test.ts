/**
 * The pure, network-free core of source serving: the line-range slice and the path containment
 * that rejects any escape out of the source root before a byte is read. `sendSource` is exercised
 * over a fake ServerResponse that captures status + body, so no socket is opened.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { ServerResponse } from "node:http";
import { readSourceSlice, sendSource } from "./source-serve";
import { WebError } from "./web-error";

let root: string;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "meridian-source-"));
  writeFileSync(join(root, "sample.ts"), "one\ntwo\nthree\nfour\nfive");
  writeFileSync(join(root, "big.ts"), Array.from({ length: 2500 }, (_, index) => `line ${index + 1}`).join("\n"));
});

afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("readSourceSlice", () => {
  it("returns the inclusive start..end range", () => {
    expect(readSourceSlice(root, "sample.ts", "2", "4")).toEqual({
      file: "sample.ts",
      startLine: 2,
      endLine: 4,
      code: "two\nthree\nfour",
      truncated: false,
    });
  });

  it("defaults missing bounds to the whole file and clamps out-of-range bounds", () => {
    expect(readSourceSlice(root, "sample.ts", null, null)).toMatchObject({ startLine: 1, endLine: 5 });
    expect(readSourceSlice(root, "sample.ts", "0", "99")).toMatchObject({ startLine: 1, endLine: 5 });
    expect(readSourceSlice(root, "sample.ts", "not-a-number", null)).toMatchObject({ startLine: 1 });
  });

  it("caps the returned slice and flags it truncated", () => {
    const slice = readSourceSlice(root, "big.ts", "1", "2500");
    expect(slice.truncated).toBe(true);
    expect(slice.endLine).toBe(2000);
    expect(slice.code.split("\n")).toHaveLength(2000);
  });

  it("rejects a `..` escape and an absolute path out of the root", () => {
    expect(() => readSourceSlice(root, "../secret.ts", null, null)).toThrow(WebError);
    expect(() => readSourceSlice(root, "/etc/passwd", null, null)).toThrow(WebError);
  });

  it("404s a file that does not exist", () => {
    expect(() => readSourceSlice(root, "nope.ts", null, null)).toThrow(
      expect.objectContaining({ status: 404 }),
    );
  });
});

// A cloned repo is untrusted: a symlink inside the clone can point at an external file (e.g.
// `/etc/passwd`). Containment must be checked on the resolved real path, not the lexical one, so
// the link is never followed out of the root.
describe("resolveWithinRoot symlink containment", () => {
  let linkRoot: string;
  let outsideDir: string;
  let symlinked = false;

  beforeAll(() => {
    outsideDir = mkdtempSync(join(tmpdir(), "meridian-outside-"));
    writeFileSync(join(outsideDir, "secret.ts"), "SECRET");
    linkRoot = mkdtempSync(join(tmpdir(), "meridian-link-"));
    writeFileSync(join(linkRoot, "ok.ts"), "safe\ncontent");
    try {
      symlinkSync(join(outsideDir, "secret.ts"), join(linkRoot, "escape"));
      symlinked = true;
    } catch {
      symlinked = false; // symlink creation not permitted on this platform — skip the negative case
    }
  });

  afterAll(() => {
    rmSync(linkRoot, { recursive: true, force: true });
    rmSync(outsideDir, { recursive: true, force: true });
  });

  it("reads a real file that lives inside the root", () => {
    expect(readSourceSlice(linkRoot, "ok.ts", null, null)).toMatchObject({ code: "safe\ncontent" });
  });

  it("refuses to follow a symlink that escapes the root", () => {
    if (!symlinked) return;
    expect(() => readSourceSlice(linkRoot, "escape", null, null)).toThrow(WebError);
    expect(() => readSourceSlice(linkRoot, "escape", null, null)).toThrow(
      expect.objectContaining({ status: 400 }),
    );
  });
});

describe("sendSource", () => {
  it("404s when no source root is configured", () => {
    const { response, captured } = fakeResponse();
    sendSource(response, null, new URLSearchParams());
    expect(captured.status).toBe(404);
    expect(JSON.parse(captured.body)).toEqual({ error: "source not available" });
  });

  it("serves a slice as JSON for a valid request", () => {
    const { response, captured } = fakeResponse();
    sendSource(response, root, new URLSearchParams({ file: "sample.ts", start: "2", end: "3" }));
    expect(captured.status).toBe(200);
    expect(JSON.parse(captured.body)).toMatchObject({ startLine: 2, endLine: 3, code: "two\nthree" });
  });

  it("400s a missing file param and an escaping path, 404s a missing file", () => {
    expect(statusFor(new URLSearchParams())).toBe(400);
    expect(statusFor(new URLSearchParams({ file: "../secret.ts" }))).toBe(400);
    expect(statusFor(new URLSearchParams({ file: "nope.ts" }))).toBe(404);
  });
});

function statusFor(query: URLSearchParams): number {
  const { response, captured } = fakeResponse();
  sendSource(response, root, query);
  return captured.status;
}

function fakeResponse(): { response: ServerResponse; captured: { status: number; body: string } } {
  const captured = { status: 0, body: "" };
  const response = {
    writeHead(status: number) {
      captured.status = status;
      return response;
    },
    end(body?: string) {
      captured.body = body ?? "";
    },
  } as unknown as ServerResponse;
  return { response, captured };
}
