/**
 * The pure, network-free core of source serving: the line-range slice and the path containment
 * that rejects any escape out of the source root before a byte is read. `sendSource` is exercised
 * over a fake ServerResponse that captures status + body, so no socket is opened.
 */

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  mkdtempSync,
  renameSync,
  rmSync,
  symlinkSync,
  truncateSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { ServerResponse } from "node:http";
import { SOURCE_TEXT_HEADERS } from "@meridian/core";
import { readSourceSlice, sendSource } from "./source-serve";
import { SourceTextAdmission } from "./source-text-admission";
import { WebError } from "./web-error";

let root: string;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "meridian-source-"));
  writeFileSync(join(root, "sample.ts"), "one\ntwo\nthree\nfour\nfive");
  writeFileSync(join(root, "terminated.ts"), "one\ntwo\n");
  writeFileSync(join(root, "crlf-terminated.ts"), "one\r\ntwo\r\n");
  writeFileSync(join(root, "blank-tail.ts"), "one\ntwo\n\n");
  writeFileSync(join(root, "empty.ts"), "");
  writeFileSync(join(root, "one-blank-line.ts"), "\n");
  writeFileSync(join(root, " spaced.ts "), "whitespace path");
  writeFileSync(join(root, "oversized.ts"), "x");
  truncateSync(join(root, "oversized.ts"), 32 * 1024 * 1024 + 1);
  writeFileSync(join(root, "capped-boundary.ts"), `${"x".repeat(1_999_999)}\nrest`);
  writeFileSync(join(root, "big.ts"), Array.from({ length: 2500 }, (_, index) => `line ${index + 1}`).join("\n"));
  writeFileSync(join(root, "swap.ts"), "original inode");
});

afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("readSourceSlice", () => {
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
  it("404s when no source root is configured", async () => {
    const { response, captured } = fakeResponse();
    await sendSource(response, null, new URLSearchParams(), sourceOptions());
    expect(captured.status).toBe(404);
    expect(JSON.parse(captured.body)).toEqual({ error: "source not available" });
  });

  it("serves one strict raw UTF-8 v1 body with exact line and length headers", async () => {
    const { response, captured } = fakeResponse();
    await sendSource(response, root, new URLSearchParams({ file: "sample.ts", start: "2", end: "3" }), sourceOptions());
    expect(captured.status).toBe(200);
    expect(captured.body).toBe("two\nthree");
    expect(captured.headers).toMatchObject({
      "content-type": "text/plain; charset=utf-8",
      "content-length": String(Buffer.byteLength(captured.body)),
      [SOURCE_TEXT_HEADERS.version]: "1",
      [SOURCE_TEXT_HEADERS.startLine]: "2",
      [SOURCE_TEXT_HEADERS.endLine]: "3",
      [SOURCE_TEXT_HEADERS.lineCount]: "2",
      [SOURCE_TEXT_HEADERS.truncated]: "0",
    });
  });

  it("preserves leading and trailing whitespace in a valid Git filename", async () => {
    const { response, captured } = fakeResponse();
    await sendSource(response, root, new URLSearchParams({ file: " spaced.ts " }), sourceOptions());
    expect(captured.status).toBe(200);
    expect(captured.body).toBe("whitespace path");
  });

  it("400s a missing file param and an escaping path, 404s a missing file", async () => {
    await expect(statusFor(new URLSearchParams())).resolves.toBe(400);
    await expect(statusFor(new URLSearchParams({ file: "../secret.ts" }))).resolves.toBe(400);
    await expect(statusFor(new URLSearchParams({ file: "nope.ts" }))).resolves.toBe(404);
  });

  it("rejects overload before reading and publishes Retry-After", async () => {
    const admission = new SourceTextAdmission({ maxActive: 1, memoryBudgetBytes: 1 });
    const held = admission.tryAcquire(1)!;
    const { response, captured } = fakeResponse();

    await sendSource(
      response,
      root,
      new URLSearchParams({ file: "sample.ts" }),
      { admission },
    );

    expect(captured.status).toBe(503);
    expect(captured.headers["retry-after"]).toBe("1");
    expect(JSON.parse(captured.body)).toEqual({ error: "source memory budget is busy; retry later" });
    held.release();
  });

  it("reads only the inode that passed containment and size admission", async () => {
    const admission = new SourceTextAdmission();
    const originalTryAcquire = admission.tryAcquire.bind(admission);
    const sourcePath = join(root, "swap.ts");
    const oldPath = join(root, "swap-old.ts");
    vi.spyOn(admission, "tryAcquire").mockImplementation((weight) => {
      renameSync(sourcePath, oldPath);
      writeFileSync(sourcePath, "replacement inode with different bytes");
      return originalTryAcquire(weight);
    });
    const { response, captured } = fakeResponse();
    try {
      await sendSource(response, root, new URLSearchParams({ file: "swap.ts" }), { admission });
      expect(captured.status).toBe(409);
      expect(JSON.parse(captured.body)).toEqual({ error: "source file changed while it was being read" });
      expect(captured.body).not.toContain("replacement inode");
      expect(admission.snapshot.active).toBe(0);
    } finally {
      unlinkSync(sourcePath);
      renameSync(oldPath, sourcePath);
    }
  });

  it("destroys an unstarted response when source ownership is revoked after admission", async () => {
    const admission = new SourceTextAdmission();
    const originalTryAcquire = admission.tryAcquire.bind(admission);
    const controller = new AbortController();
    vi.spyOn(admission, "tryAcquire").mockImplementation((weight) => {
      const lease = originalTryAcquire(weight);
      controller.abort(new Error("source capability ownership expired"));
      return lease;
    });
    const { response, captured } = fakeResponse();

    await sendSource(
      response,
      root,
      new URLSearchParams({ file: "sample.ts" }),
      { admission, signal: controller.signal },
    );

    expect(captured.status).toBe(0);
    expect(captured.body).toBe("");
    expect(captured.destroyed).toBe(true);
    expect(admission.snapshot.active).toBe(0);
  });

  it("yields before the production file read and releases admission on cancellation", async () => {
    const admission = new SourceTextAdmission();
    const controller = new AbortController();
    const { response } = fakeResponse();
    let eventLoopTurn = false;
    const pending = sendSource(
      response,
      root,
      new URLSearchParams({ file: "big.ts" }),
      { admission, signal: controller.signal },
    );
    const turn = new Promise<void>((resolveTurn) => setImmediate(() => {
      eventLoopTurn = true;
      resolveTurn();
    }));
    await turn;
    expect(eventLoopTurn).toBe(true);
    controller.abort();
    await pending;
    expect(admission.snapshot.active).toBe(0);
  });
});

async function statusFor(query: URLSearchParams): Promise<number> {
  const { response, captured } = fakeResponse();
  await sendSource(response, root, query, sourceOptions());
  return captured.status;
}

function fakeResponse(): {
  response: ServerResponse;
  captured: { status: number; body: string; headers: Record<string, string>; destroyed: boolean };
} {
  const captured = { status: 0, body: "", headers: {} as Record<string, string>, destroyed: false };
  const listeners = new Map<string, (...args: unknown[]) => void>();
  const response = {
    writeHead(status: number, headers?: Record<string, string>) {
      captured.status = status;
      captured.headers = { ...captured.headers, ...headers };
      return response;
    },
    setHeader(name: string, value: string | number) {
      captured.headers[name.toLowerCase()] = String(value);
      return response;
    },
    end(body?: string | Buffer, callback?: () => void) {
      captured.body = Buffer.isBuffer(body) ? body.toString("utf8") : body ?? "";
      callback?.();
    },
    once(event: string, listener: (...args: unknown[]) => void) {
      listeners.set(event, listener);
      return response;
    },
    off(event: string) {
      listeners.delete(event);
      return response;
    },
    destroyed: false,
    writableEnded: false,
    destroy() {
      captured.destroyed = true;
      response.destroyed = true;
      return response;
    },
  } as unknown as ServerResponse;
  return { response, captured };
}

function sourceOptions(signal?: AbortSignal) {
  return { admission: new SourceTextAdmission(), ...(signal === undefined ? {} : { signal }) };
}
