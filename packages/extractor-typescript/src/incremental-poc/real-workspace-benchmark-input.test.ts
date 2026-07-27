import { createHash } from "node:crypto";
import {
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  loadBenchmarkSupplementalFiles,
  parseRealWorkspaceBenchmarkArguments,
} from "./real-workspace-benchmark-input";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("real workspace benchmark inputs", () => {
  it("parses the backward-compatible base form and strict optional supplemental path", () => {
    expect(parseRealWorkspaceBenchmarkArguments([
      "/repo",
      "a".repeat(40),
      "/cache",
    ])).toEqual({
      rootInput: "/repo",
      treeOid: "a".repeat(40),
      cacheDirInput: "/cache",
      benchmarkVersion: "local-source",
      supplementalFilesJsonPath: null,
    });
    expect(parseRealWorkspaceBenchmarkArguments([
      "/repo",
      "B".repeat(64),
      "/cache",
      "benchmark-v2",
      "/inputs/changed-typescript.json",
    ])).toEqual({
      rootInput: "/repo",
      treeOid: "b".repeat(64),
      cacheDirInput: "/cache",
      benchmarkVersion: "benchmark-v2",
      supplementalFilesJsonPath: "/inputs/changed-typescript.json",
    });
  });

  it("rejects ambiguous, malformed, or relative argument forms", () => {
    expect(() => parseRealWorkspaceBenchmarkArguments(["/repo", "a".repeat(40)]))
      .toThrow(/usage/);
    expect(() => parseRealWorkspaceBenchmarkArguments([
      "/repo",
      "a".repeat(40),
      "/cache",
      "v1",
      "/inputs.json",
      "extra",
    ])).toThrow(/usage/);
    expect(() => parseRealWorkspaceBenchmarkArguments([
      "/repo",
      "not-an-oid",
      "/cache",
    ])).toThrow(/tree OID/);
    expect(() => parseRealWorkspaceBenchmarkArguments([
      "/repo",
      "a".repeat(40),
      "/cache",
      "v1",
      "relative.json",
    ])).toThrow(/must be absolute/);
  });

  it("loads, sorts, and fingerprints one exact unique TypeScript path list", () => {
    const root = temporaryDirectory();
    const input = join(root, "supplemental.json");
    const paths = [
      "packages/z/src/view.tsx",
      "packages/a/src/index.ts",
    ];
    writeFileSync(input, JSON.stringify(paths));

    expect(loadBenchmarkSupplementalFiles(input)).toEqual({
      sourcePath: input,
      paths: [...paths].sort(),
      digest: createHash("sha256")
        .update(JSON.stringify([...paths].sort()))
        .digest("hex"),
    });
    expect(loadBenchmarkSupplementalFiles(null)).toEqual({
      sourcePath: null,
      paths: [],
      digest: createHash("sha256").update("[]").digest("hex"),
    });
  });

  it.each([
    [["packages/a/src/index.ts", "packages/a/src/index.ts"], /duplicate path/],
    [["/absolute.ts"], /root-relative/],
    [["../escape.ts"], /root-relative/],
    [["packages\\windows.ts"], /root-relative/],
    [["packages/a/src/style.css"], /\.ts or \.tsx/],
    [[".git/config.ts"], /root-relative/],
    [{ paths: ["packages/a/src/index.ts"] }, /must be an array/],
  ])("rejects an invalid supplemental schema: %j", (value, message) => {
    const root = temporaryDirectory();
    const input = join(root, "invalid.json");
    writeFileSync(input, JSON.stringify(value));
    expect(() => loadBenchmarkSupplementalFiles(input)).toThrow(message);
  });

  it("bounds allocation and rejects non-UTF-8 or symlinked inputs", () => {
    const root = temporaryDirectory();
    const oversized = join(root, "oversized.json");
    writeFileSync(oversized, "x".repeat(1024 * 1024 + 1));
    expect(() => loadBenchmarkSupplementalFiles(oversized)).toThrow(/at most 1048576 bytes/);

    const nonUtf8 = join(root, "non-utf8.json");
    writeFileSync(nonUtf8, Buffer.from([0xff]));
    expect(() => loadBenchmarkSupplementalFiles(nonUtf8)).toThrow(/valid UTF-8 JSON/);

    const target = join(root, "target.json");
    const linked = join(root, "linked.json");
    writeFileSync(target, "[]");
    symlinkSync(target, linked);
    expect(() => loadBenchmarkSupplementalFiles(linked)).toThrow(/no-follow regular file/);
  });
});

function temporaryDirectory(): string {
  const root = mkdtempSync(join(tmpdir(), "meridian-benchmark-input-"));
  roots.push(root);
  return root;
}
