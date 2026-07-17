import { describe, expect, it } from "vitest";
import {
  SOURCE_TEXT_HEADERS,
  parseSourceTextMetadata,
  serializeSourceTextMetadata,
} from "./source-text-contract";

describe("source text contract", () => {
  it("round-trips a non-empty inclusive range with canonical header spellings", () => {
    expect(serializeSourceTextMetadata({
      startLine: 7,
      endLine: 9,
      lineCount: 3,
      truncated: false,
    })).toEqual({
      [SOURCE_TEXT_HEADERS.version]: "1",
      [SOURCE_TEXT_HEADERS.startLine]: "7",
      [SOURCE_TEXT_HEADERS.endLine]: "9",
      [SOURCE_TEXT_HEADERS.lineCount]: "3",
      [SOURCE_TEXT_HEADERS.truncated]: "0",
    });
  });

  it("represents an empty source range without inventing a row", () => {
    expect(parseSourceTextMetadata({
      version: "1",
      startLine: "1",
      endLine: "0",
      lineCount: "0",
      truncated: "1",
    })).toEqual({ version: 1, startLine: 1, endLine: 0, lineCount: 0, truncated: true });
  });

  it.each([
    { version: "2", startLine: "1", endLine: "1", lineCount: "1", truncated: "0" },
    { version: "1", startLine: "01", endLine: "1", lineCount: "1", truncated: "0" },
    { version: "1", startLine: "1", endLine: "2", lineCount: "1", truncated: "0" },
    { version: "1", startLine: "1", endLine: "1", lineCount: "1", truncated: "false" },
  ])("rejects a noncanonical or inconsistent record %#", (raw) => {
    expect(() => parseSourceTextMetadata(raw)).toThrow("invalid source response");
  });
});
