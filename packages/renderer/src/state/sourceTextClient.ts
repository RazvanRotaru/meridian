import {
  SOURCE_TEXT_HEADERS,
  SOURCE_TEXT_MAX_BYTES,
  parseSourceTextMetadata,
} from "@meridian/core";

export interface SourceTextPayload {
  code: string;
  truncated: boolean;
  startLine: number;
  endLine: number;
  lineCount: number;
}

/** One response buffer plus worst-case two-byte decoded text. JSON is deliberately absent. */
export const SOURCE_TEXT_TRANSIENT_BYTES = SOURCE_TEXT_MAX_BYTES * 3;

export async function fetchSourceText(
  fetchImpl: typeof fetch,
  url: URL,
  signal: AbortSignal,
): Promise<SourceTextPayload> {
  signal.throwIfAborted();
  const response = await fetchImpl(url, {
    credentials: "same-origin",
    headers: { accept: "text/plain" },
    signal,
  });
  if (signal.aborted) {
    await cancelBody(response, "source request was cancelled");
    signal.throwIfAborted();
  }
  if (!response.ok) {
    await cancelBody(response, "source request failed");
    throw new Error(`source request failed with ${response.status}`);
  }
  let metadata: ReturnType<typeof parseSourceTextMetadata>;
  let contentLength: number;
  try {
    const contentType = response.headers.get("content-type")?.toLowerCase();
    if (contentType !== "text/plain; charset=utf-8") {
      throw new Error("invalid source response: expected text/plain; charset=utf-8");
    }
    metadata = parseSourceTextMetadata({
      version: response.headers.get(SOURCE_TEXT_HEADERS.version),
      startLine: response.headers.get(SOURCE_TEXT_HEADERS.startLine),
      endLine: response.headers.get(SOURCE_TEXT_HEADERS.endLine),
      lineCount: response.headers.get(SOURCE_TEXT_HEADERS.lineCount),
      truncated: response.headers.get(SOURCE_TEXT_HEADERS.truncated),
    });
    contentLength = canonicalContentLength(response.headers.get("content-length"));
    if (contentLength > SOURCE_TEXT_MAX_BYTES) {
      throw new Error(`source response exceeds the ${SOURCE_TEXT_MAX_BYTES}-byte limit`);
    }
  } catch (error) {
    await cancelBody(response, "invalid source response metadata");
    throw error;
  }
  const bytes = await readExactBody(response, contentLength, signal);
  signal.throwIfAborted();
  let code: string;
  try {
    code = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error("invalid source response: expected UTF-8");
  }
  const decodedLines = code.length === 0 && metadata.lineCount > 0 ? 1 : countSourceLines(code);
  // The explicit zero-row shape disambiguates an empty file from one visible blank row. Every
  // non-empty body must agree exactly with its coordinate metadata before entering the LRU.
  if ((metadata.lineCount === 0 && code.length !== 0)
    || (metadata.lineCount > 0 && decodedLines !== metadata.lineCount)) {
    throw new Error("invalid source response: body does not match line metadata");
  }
  return {
    code,
    truncated: metadata.truncated,
    startLine: metadata.startLine,
    endLine: metadata.endLine,
    lineCount: metadata.lineCount,
  };
}

/** Count logical rows without retaining an array proportional to the number of source lines. */
function countSourceLines(code: string): number {
  if (code.length === 0) return 0;
  let count = 1;
  let cursor = -1;
  while ((cursor = code.indexOf("\n", cursor + 1)) !== -1) count += 1;
  return count;
}

function canonicalContentLength(value: string | null): number {
  if (value === null || !/^(?:0|[1-9][0-9]*)$/.test(value)) {
    throw new Error("invalid source response: content-length is required and must be canonical");
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new Error("invalid source response: content-length is outside the safe integer range");
  }
  return parsed;
}

async function readExactBody(
  response: Response,
  contentLength: number,
  signal: AbortSignal,
): Promise<Uint8Array> {
  if (response.body === null) throw new Error("invalid source response: body is required");
  const reader = response.body.getReader();
  const payload = new Uint8Array(contentLength);
  let offset = 0;
  const onAbort = () => {
    void reader.cancel(signal.reason).catch(() => undefined);
  };
  signal.addEventListener("abort", onAbort, { once: true });
  if (signal.aborted) onAbort();
  try {
    for (;;) {
      signal.throwIfAborted();
      const { value, done } = await reader.read();
      if (done) break;
      if (offset + value.byteLength > contentLength) {
        try {
          await reader.cancel("source response exceeds content-length");
        } catch {
          // The strict framing failure below remains authoritative.
        }
        throw new Error("invalid source response: content-length does not match the body");
      }
      payload.set(value, offset);
      offset += value.byteLength;
    }
  } finally {
    signal.removeEventListener("abort", onAbort);
    reader.releaseLock();
  }
  signal.throwIfAborted();
  if (offset !== contentLength) {
    throw new Error("invalid source response: content-length does not match the body");
  }
  return payload;
}

async function cancelBody(response: Response, reason: string): Promise<void> {
  try {
    await response.body?.cancel(reason);
  } catch {
    // Protocol/status validation is authoritative; cleanup cannot replace it.
  }
}
