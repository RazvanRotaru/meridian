/**
 * The pure, network-free core of source serving: the line-range slice and the path containment
 * that rejects any escape out of the source root before a byte is read. `sendSource` is exercised
 * over a fake ServerResponse that captures status + body, so no socket is opened.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, truncateSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { ServerResponse } from "node:http";
import { isGitAdministrativePath, readSourceSlice, sendSource } from "./source-serve";
import { WebError } from "./web-error";

let root: string;
let gitAdministrationSymlinked = false;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "meridian-source-"));
  writeFileSync(join(root, "sample.ts"), "one\ntwo\nthree\nfour\nfive");
  writeFileSync(join(root, "terminated.ts"), "one\ntwo\n");
  writeFileSync(join(root, "crlf-terminated.ts"), "one\r\ntwo\r\n");
  writeFileSync(join(root, "blank-tail.ts"), "one\ntwo\n\n");
  writeFileSync(join(root, "empty.ts"), "");
  writeFileSync(join(root, "one-blank-line.ts"), "\n");
  writeFileSync(join(root, " spaced.ts "), "whitespace path");
  writeFileSync(join(root, ".git"), "gitdir: /private/cache/repository-store/mirror.git/worktrees/repo\n");
  mkdirSync(join(root, "nested", ".git"), { recursive: true });
  writeFileSync(join(root, "nested", ".git", "config"), "private git administration");
  try {
    symlinkSync(".git", join(root, "git-admin-link"));
    symlinkSync(join("nested", ".git", "config"), join(root, "git-config-link"));
    gitAdministrationSymlinked = true;
  } catch {
    gitAdministrationSymlinked = false;
  }
  writeFileSync(join(root, "oversized.ts"), "x");
  truncateSync(join(root, "oversized.ts"), 32 * 1024 * 1024 + 1);
  writeFileSync(join(root, "capped-boundary.ts"), `${"x".repeat(1_999_999)}\nrest`);
  writeFileSync(join(root, "big.ts"), Array.from({ length: 2500 }, (_, index) => `line ${index + 1}`).join("\n"));
});

afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("readSourceSlice", () => {
  it("recognizes Win32 aliases for linked-worktree Git administration without changing POSIX spelling", () => {
    for (const file of [".git", ".GIT", ".git.", ".git ", ".git::$DATA", "nested/.git...::$DATA/config"]) {
      expect(isGitAdministrativePath(file, "win32")).toBe(true);
    }
    expect(isGitAdministrativePath(".git.", "linux")).toBe(false);
    expect(isGitAdministrativePath("src/.github/workflows/check.yml", "win32")).toBe(false);
  });

  it("returns the inclusive start..end range", () => {
    expect(readSourceSlice(root, "sample.ts", "2", "4")).toEqual({
      file: "sample.ts",
      startLine: 2,
      endLine: 4,
      lineCount: 3,
      code: "two\nthree\nfour",
      truncated: false,
    });
  });

  it("defaults missing bounds to the whole file and clamps out-of-range bounds", () => {
    expect(readSourceSlice(root, "sample.ts", null, null)).toMatchObject({ startLine: 1, endLine: 5 });
    expect(readSourceSlice(root, "sample.ts", "0", "99")).toMatchObject({ startLine: 1, endLine: 5 });
    expect(readSourceSlice(root, "sample.ts", "not-a-number", null)).toMatchObject({ startLine: 1 });
  });

  it("does not expose a phantom row for LF- or CRLF-terminated files", () => {
    expect(readSourceSlice(root, "terminated.ts", null, null)).toMatchObject({
      startLine: 1,
      endLine: 2,
      code: "one\ntwo",
    });
    expect(readSourceSlice(root, "crlf-terminated.ts", null, null)).toMatchObject({
      startLine: 1,
      endLine: 2,
      code: "one\ntwo",
    });
  });

  it("preserves an intentional blank final line", () => {
    expect(readSourceSlice(root, "blank-tail.ts", null, null)).toMatchObject({
      startLine: 1,
      endLine: 3,
      code: "one\ntwo\n",
    });
  });

  it("distinguishes an empty file from a file containing one blank line", () => {
    expect(readSourceSlice(root, "empty.ts", null, null)).toEqual({
      file: "empty.ts",
      startLine: 1,
      endLine: 0,
      lineCount: 0,
      code: "",
      truncated: false,
    });
    expect(readSourceSlice(root, "one-blank-line.ts", null, null)).toEqual({
      file: "one-blank-line.ts",
      startLine: 1,
      endLine: 1,
      lineCount: 1,
      code: "",
      truncated: false,
    });
  });

  it("serves a later-line slice beyond the response byte budget boundary", () => {
    expect(readSourceSlice(root, "capped-boundary.ts", "2", "2")).toMatchObject({
      startLine: 2,
      endLine: 2,
      code: "rest",
      truncated: false,
    });
  });

  it("returns a normal file with more than 2,000 lines completely", () => {
    const slice = readSourceSlice(root, "big.ts", "1", "2500");
    expect(slice.truncated).toBe(false);
    expect(slice.endLine).toBe(2500);
    expect(slice.code.split("\n")).toHaveLength(2500);
    expect(slice.code).toContain("line 2500");
  });

  it("does not erase a later diff zone behind an arbitrary response-byte cap", () => {
    const slice = readSourceSlice(root, "capped-boundary.ts", null, null);
    expect(slice.truncated).toBe(false);
    expect(slice.endLine).toBe(2);
    expect(Buffer.byteLength(slice.code, "utf8")).toBeGreaterThan(2_000_000);
    expect(slice.code.endsWith("\nrest")).toBe(true);
  });

  it("rejects an oversized untrusted file before reading it", () => {
    expect(() => readSourceSlice(root, "oversized.ts", "1", "1")).toThrow(
      expect.objectContaining({ status: 413 }),
    );
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

  it("never serves linked-worktree or nested Git administrative files", () => {
    for (const file of [".git", "nested/.git/config", "nested\\.GIT\\config"]) {
      expect(() => readSourceSlice(root, file, null, null)).toThrow(
        expect.objectContaining({ status: 404 }),
      );
    }
  });

  it("never follows an innocent-looking symlink into Git administrative state", () => {
    if (!gitAdministrationSymlinked) return;
    for (const file of ["git-admin-link", "git-config-link"]) {
      expect(() => readSourceSlice(root, file, null, null)).toThrow(
        expect.objectContaining({ status: 404 }),
      );
    }
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

  it("preserves leading and trailing whitespace in a valid Git filename", () => {
    const { response, captured } = fakeResponse();
    sendSource(response, root, new URLSearchParams({ file: " spaced.ts " }));
    expect(captured.status).toBe(200);
    expect(JSON.parse(captured.body)).toMatchObject({ file: " spaced.ts ", code: "whitespace path" });
  });

  it("400s a missing file param and an escaping path, 404s a missing file", () => {
    expect(statusFor(new URLSearchParams())).toBe(400);
    expect(statusFor(new URLSearchParams({ file: "../secret.ts" }))).toBe(400);
    expect(statusFor(new URLSearchParams({ file: "nope.ts" }))).toBe(404);
    expect(statusFor(new URLSearchParams({ file: ".git" }))).toBe(404);
    expect(statusFor(new URLSearchParams({ file: "nested/.git/config" }))).toBe(404);
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
