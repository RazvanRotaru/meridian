/**
 * Strict source-text transport shared by the CLI server and browser renderer.
 *
 * Source bytes are the response body. Small, canonical headers carry the line coordinate instead
 * of wrapping an attacker-sized file in JSON (which would duplicate and potentially expand it
 * during stringify/decode/parse). There is one protocol version and no compatibility shape.
 */

export const SOURCE_TEXT_PROTOCOL_VERSION = 1 as const;
export const SOURCE_TEXT_MAX_BYTES = 32 * 1024 * 1024;

export const SOURCE_TEXT_HEADERS = Object.freeze({
  version: "x-meridian-source-version",
  startLine: "x-meridian-source-start-line",
  endLine: "x-meridian-source-end-line",
  lineCount: "x-meridian-source-line-count",
  truncated: "x-meridian-source-truncated",
} as const);

export interface SourceTextMetadata {
  version: typeof SOURCE_TEXT_PROTOCOL_VERSION;
  startLine: number;
  endLine: number;
  lineCount: number;
  truncated: boolean;
}

export interface SerializedSourceTextMetadata {
  version: string | null;
  startLine: string | null;
  endLine: string | null;
  lineCount: string | null;
  truncated: string | null;
}

/** Validate the canonical wire spelling and the exact inclusive line-range invariant. */
export function parseSourceTextMetadata(raw: SerializedSourceTextMetadata): SourceTextMetadata {
  if (raw.version !== String(SOURCE_TEXT_PROTOCOL_VERSION)) {
    throw new Error(`invalid source response: expected protocol version ${SOURCE_TEXT_PROTOCOL_VERSION}`);
  }
  const startLine = canonicalInteger(raw.startLine, "start line");
  const endLine = canonicalInteger(raw.endLine, "end line");
  const lineCount = canonicalInteger(raw.lineCount, "line count");
  if (startLine < 1 || lineCount < 0) {
    throw new Error("invalid source response: line metadata is out of range");
  }
  const expectedEnd = lineCount === 0 ? startLine - 1 : startLine + lineCount - 1;
  if (!Number.isSafeInteger(expectedEnd) || endLine !== expectedEnd) {
    throw new Error("invalid source response: line metadata is inconsistent");
  }
  if (raw.truncated !== "0" && raw.truncated !== "1") {
    throw new Error("invalid source response: truncated must be 0 or 1");
  }
  return {
    version: SOURCE_TEXT_PROTOCOL_VERSION,
    startLine,
    endLine,
    lineCount,
    truncated: raw.truncated === "1",
  };
}

/** Canonical success headers; callers add content type/length and cache policy. */
export function serializeSourceTextMetadata(
  metadata: Omit<SourceTextMetadata, "version">,
): Record<(typeof SOURCE_TEXT_HEADERS)[keyof typeof SOURCE_TEXT_HEADERS], string> {
  const validated = parseSourceTextMetadata({
    version: String(SOURCE_TEXT_PROTOCOL_VERSION),
    startLine: String(metadata.startLine),
    endLine: String(metadata.endLine),
    lineCount: String(metadata.lineCount),
    truncated: metadata.truncated ? "1" : "0",
  });
  return {
    [SOURCE_TEXT_HEADERS.version]: String(validated.version),
    [SOURCE_TEXT_HEADERS.startLine]: String(validated.startLine),
    [SOURCE_TEXT_HEADERS.endLine]: String(validated.endLine),
    [SOURCE_TEXT_HEADERS.lineCount]: String(validated.lineCount),
    [SOURCE_TEXT_HEADERS.truncated]: validated.truncated ? "1" : "0",
  };
}

function canonicalInteger(value: string | null, label: string): number {
  if (value === null || !/^(?:0|[1-9][0-9]*)$/.test(value)) {
    throw new Error(`invalid source response: ${label} is not a canonical integer`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new Error(`invalid source response: ${label} is outside the safe integer range`);
  }
  return parsed;
}
