import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { reviewFingerprintsFromArtifact, type GraphArtifact } from "@meridian/core";
import { withReviewFingerprints } from "./review-fingerprints";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("withReviewFingerprints", () => {
  it("hashes exact declaration bytes independently of absolute line movement", () => {
    const first = fingerprint("const unrelated = 1;\nexport function run() {\n  return 1;\n}\n", 2, 4);
    const shifted = fingerprint("// inserted\nconst unrelated = 1;\nexport function run() {\n  return 1;\n}\n", 3, 5);
    expect(shifted.units["ts:src/a.ts#run"]).toEqual(first.units["ts:src/a.ts#run"]);
  });

  it("changes the digest when declaration text changes at identical geometry", () => {
    const first = fingerprint("export function run() {\n  return 1;\n}\n", 1, 3);
    const changed = fingerprint("export function run() {\n  return 2;\n}\n", 1, 3);
    expect(changed.units["ts:src/a.ts#run"]?.address).toBe(first.units["ts:src/a.ts#run"]?.address);
    expect(changed.units["ts:src/a.ts#run"]?.digest).not.toBe(first.units["ts:src/a.ts#run"]?.digest);
  });

  it("publishes a full-file digest for module-only files", () => {
    const root = mkdtempSync(join(tmpdir(), "meridian-review-fingerprint-"));
    roots.push(root);
    writeFileSync(join(root, "notes.md"), "review me\n");
    const artifact = withReviewFingerprints({
      schemaVersion: "1.1.0",
      generatedAt: "2026-07-22T00:00:00Z",
      generator: { name: "test", version: "1" },
      target: { name: "test", root: ".", language: "mixed" },
      nodes: [{
        id: "md:notes.md",
        kind: "module",
        qualifiedName: "notes.md",
        displayName: "notes.md",
        location: { file: "notes.md", startLine: 1, endLine: 1 },
      }],
      edges: [],
    } satisfies GraphArtifact, root);
    expect(reviewFingerprintsFromArtifact(artifact)?.files["notes.md"]).toMatchObject({
      address: "file:v1\0notes.md",
      digest: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
  });

  it("keeps the sidecar scoped to the bounded review file selection", () => {
    const root = mkdtempSync(join(tmpdir(), "meridian-review-fingerprint-"));
    roots.push(root);
    writeFileSync(join(root, "a.ts"), "export const a = 1;\n");
    writeFileSync(join(root, "b.ts"), "export const b = 1;\n");
    const nodes = ["a.ts", "b.ts"].map((file) => ({
      id: `ts:${file}#value`,
      kind: "variable",
      qualifiedName: "value",
      displayName: "value",
      location: { file, startLine: 1, endLine: 1 },
    }));
    const artifact = withReviewFingerprints({
      schemaVersion: "1.1.0",
      generatedAt: "2026-07-22T00:00:00Z",
      generator: { name: "test", version: "1" },
      target: { name: "test", root: ".", language: "typescript" },
      nodes,
      edges: [],
    } satisfies GraphArtifact, root, { mode: "files", files: ["a.ts"] });
    const sidecar = reviewFingerprintsFromArtifact(artifact)!;
    expect(Object.keys(sidecar.files)).toEqual(["a.ts"]);
    expect(Object.keys(sidecar.units)).toEqual(["ts:a.ts#value"]);
  });

  it("keeps a literal backslash filename distinct from its slash-path sibling on POSIX", () => {
    if (process.platform === "win32") return;
    const root = mkdtempSync(join(tmpdir(), "meridian-review-fingerprint-"));
    roots.push(root);
    const literalBackslash = "literal\\name.ts";
    const slashPath = "literal/name.ts";
    mkdirSync(join(root, "literal"));
    writeFileSync(join(root, literalBackslash), "export const literal = 1;\n");
    writeFileSync(join(root, slashPath), "export const slash = 2;\n");
    const artifact = withReviewFingerprints({
      schemaVersion: "1.1.0",
      generatedAt: "2026-07-22T00:00:00Z",
      generator: { name: "test", version: "1" },
      target: { name: "test", root: ".", language: "typescript" },
      nodes: [literalBackslash, slashPath].map((file) => ({
        id: `ts:${file}`,
        kind: "module",
        qualifiedName: file,
        displayName: file,
        location: { file, startLine: 1, endLine: 1 },
      })),
      edges: [],
    } satisfies GraphArtifact, root);
    const files = reviewFingerprintsFromArtifact(artifact)!.files;

    expect(Object.keys(files).sort()).toEqual([literalBackslash, slashPath].sort());
    expect(files[literalBackslash]?.address).toBe(`file:v1\0${literalBackslash}`);
    expect(files[slashPath]?.address).toBe(`file:v1\0${slashPath}`);
    expect(files[literalBackslash]?.digest).not.toBe(files[slashPath]?.digest);
  });
});

function fingerprint(source: string, startLine: number, endLine: number) {
  const root = mkdtempSync(join(tmpdir(), "meridian-review-fingerprint-"));
  roots.push(root);
  writeFileSync(join(root, "a.ts"), source);
  const artifact = withReviewFingerprints({
    schemaVersion: "1.1.0",
    generatedAt: "2026-07-22T00:00:00Z",
    generator: { name: "test", version: "1" },
    target: { name: "test", root: ".", language: "typescript" },
    nodes: [{
      id: "ts:src/a.ts#run",
      kind: "function",
      qualifiedName: "run",
      displayName: "run",
      location: { file: "a.ts", startLine, endLine },
    }],
    edges: [],
  } satisfies GraphArtifact, root);
  return reviewFingerprintsFromArtifact(artifact)!;
}
