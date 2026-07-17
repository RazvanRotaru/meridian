import { SOURCE_TEXT_HEADERS, SOURCE_TEXT_MAX_BYTES } from "@meridian/core";
import { describe, expect, it, vi } from "vitest";
import { fetchSourceText } from "./sourceTextClient";

describe("fetchSourceText", () => {
  it("streams one strict v1 body into an exact allocation", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => sourceResponse("two\nthree", {
      startLine: 2,
      endLine: 3,
      lineCount: 2,
    }));

    await expect(fetchSourceText(
      fetchMock,
      new URL("http://meridian.local/api/source?id=one&file=a.ts"),
      new AbortController().signal,
    )).resolves.toEqual({
      code: "two\nthree",
      startLine: 2,
      endLine: 3,
      lineCount: 2,
      truncated: false,
    });
    expect(fetchMock).toHaveBeenCalledWith(expect.any(URL), expect.objectContaining({
      headers: { accept: "text/plain" },
    }));
  });

  it("uses line metadata to distinguish an empty file from one blank row", async () => {
    const empty = sourceResponse("", { startLine: 1, endLine: 0, lineCount: 0 });
    await expect(fetchSourceText(
      async () => empty,
      new URL("http://meridian.local/api/source"),
      new AbortController().signal,
    )).resolves.toMatchObject({ code: "", lineCount: 0 });

    const blank = sourceResponse("", { startLine: 1, endLine: 1, lineCount: 1 });
    await expect(fetchSourceText(
      async () => blank,
      new URL("http://meridian.local/api/source"),
      new AbortController().signal,
    )).resolves.toMatchObject({ code: "", lineCount: 1 });
  });

  it.each([
    { label: "missing version", headers: { [SOURCE_TEXT_HEADERS.version]: undefined } },
    { label: "noncanonical line", headers: { [SOURCE_TEXT_HEADERS.startLine]: "02" } },
    { label: "inconsistent range", headers: { [SOURCE_TEXT_HEADERS.endLine]: "4" } },
    { label: "legacy JSON", headers: { "content-type": "application/json" } },
    { label: "missing length", headers: { "content-length": undefined } },
  ])("rejects $label without a compatibility parse", async ({ headers }) => {
    const response = sourceResponse("two\nthree", {
      startLine: 2,
      endLine: 3,
      lineCount: 2,
    }, headers);
    await expect(fetchSourceText(
      async () => response,
      new URL("http://meridian.local/api/source"),
      new AbortController().signal,
    )).rejects.toThrow("invalid source response");
    expect(response.bodyUsed).toBe(true);
  });

  it("cancels an unread body when strict metadata validation fails", async () => {
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({ cancel });
    const response = new Response(body, {
      headers: sourceHeaders(0, { startLine: 1, endLine: 0, lineCount: 0 }),
    });
    response.headers.delete(SOURCE_TEXT_HEADERS.version);

    await expect(fetchSourceText(
      async () => response,
      new URL("http://meridian.local/api/source"),
      new AbortController().signal,
    )).rejects.toThrow("invalid source response");
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("cancels an active response reader when its subscriber leaves", async () => {
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({ cancel });
    const response = new Response(body, {
      headers: sourceHeaders(1, { startLine: 1, endLine: 1, lineCount: 1 }),
    });
    const controller = new AbortController();
    const pending = fetchSourceText(
      async () => response,
      new URL("http://meridian.local/api/source"),
      controller.signal,
    );

    controller.abort(new DOMException("preview closed", "AbortError"));
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("rejects an advertised body over the server contract before reading it", async () => {
    const response = sourceResponse("", { startLine: 1, endLine: 0, lineCount: 0 }, {
      "content-length": String(SOURCE_TEXT_MAX_BYTES + 1),
    });
    await expect(fetchSourceText(
      async () => response,
      new URL("http://meridian.local/api/source"),
      new AbortController().signal,
    )).rejects.toThrow(`exceeds the ${SOURCE_TEXT_MAX_BYTES}-byte limit`);
  });

  it("rejects body framing, line-count, and UTF-8 mismatches", async () => {
    const short = sourceResponse("two", { startLine: 1, endLine: 1, lineCount: 1 }, {
      "content-length": "4",
    });
    await expect(fetchSourceText(
      async () => short,
      new URL("http://meridian.local/api/source"),
      new AbortController().signal,
    )).rejects.toThrow("content-length does not match");

    const lines = sourceResponse("one\ntwo", { startLine: 1, endLine: 1, lineCount: 1 });
    await expect(fetchSourceText(
      async () => lines,
      new URL("http://meridian.local/api/source"),
      new AbortController().signal,
    )).rejects.toThrow("body does not match line metadata");

    const invalidUtf8 = new Response(new Uint8Array([0xc3, 0x28]), {
      status: 200,
      headers: sourceHeaders(2, { startLine: 1, endLine: 1, lineCount: 1 }),
    });
    await expect(fetchSourceText(
      async () => invalidUtf8,
      new URL("http://meridian.local/api/source"),
      new AbortController().signal,
    )).rejects.toThrow("expected UTF-8");
  });

  it("validates many source rows without building a line array", async () => {
    const lineCount = 250_000;
    const code = "x\n".repeat(lineCount - 1) + "x";
    const response = sourceResponse(code, { startLine: 1, endLine: lineCount, lineCount });

    await expect(fetchSourceText(
      async () => response,
      new URL("http://meridian.local/api/source"),
      new AbortController().signal,
    )).resolves.toMatchObject({ lineCount, code });
  });
});

function sourceResponse(
  body: string,
  metadata: { startLine: number; endLine: number; lineCount: number; truncated?: boolean },
  overrides: Record<string, string | undefined> = {},
): Response {
  const bytes = new TextEncoder().encode(body);
  const headers = new Headers(sourceHeaders(bytes.byteLength, metadata));
  for (const [name, value] of Object.entries(overrides)) {
    if (value === undefined) headers.delete(name);
    else headers.set(name, value);
  }
  return new Response(bytes, { status: 200, headers });
}

function sourceHeaders(
  contentLength: number,
  metadata: { startLine: number; endLine: number; lineCount: number; truncated?: boolean },
): Record<string, string> {
  return {
    "content-type": "text/plain; charset=utf-8",
    "content-length": String(contentLength),
    [SOURCE_TEXT_HEADERS.version]: "1",
    [SOURCE_TEXT_HEADERS.startLine]: String(metadata.startLine),
    [SOURCE_TEXT_HEADERS.endLine]: String(metadata.endLine),
    [SOURCE_TEXT_HEADERS.lineCount]: String(metadata.lineCount),
    [SOURCE_TEXT_HEADERS.truncated]: metadata.truncated === true ? "1" : "0",
  };
}
