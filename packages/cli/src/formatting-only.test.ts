import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { ChangedDiffLine, ChangedFileManifestEntry } from "@meridian/core";
import { afterEach, describe, expect, it } from "vitest";
import {
  proveFormattingOnlyEdits,
  type FormattingProofCandidate,
} from "./formatting-only";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("proveFormattingOnlyEdits", () => {
  it("proves Autopilot #4123's interface-signature wrap, including its trailing comma", async () => {
    const root = sourceRoot();
    const path = "src/aria/app/src/lib/msg.converter.ts";
    const oldLine = "  readonly convertBinary: (bytes: Uint8Array, extension: string, name: string) => Promise<{ markdown: string; images: readonly MsgNativeAttachment[] } | null>;";
    const headLines = [
      "export interface MsgConversionDependencies {",
      "  // Returns the child's Markdown plus any embedded Office images to surface as native children.",
      "  // (review 3645646824), or null when conversion failed.",
      "  readonly convertBinary: (",
      "    bytes: Uint8Array,",
      "    extension: string,",
      "    name: string,",
      "  ) => Promise<{ markdown: string; images: readonly MsgNativeAttachment[] } | null>;",
      "}",
    ];
    writeSource(root, path, headLines);
    const candidate = replacement(path, 4, [oldLine], headLines.slice(3, 8));

    await expect(proveFormattingOnlyEdits(root, [candidate], modified(path))).resolves.toEqual({
      version: 1,
      edits: [proofEdit(candidate)],
    });
  });

  it.each([
    [
      "a trailing comma after a rest parameter",
      ["export function f(...args: string[]) {}"],
      ["export function f(...args: string[],) {}"],
    ],
    [
      "an index-signature trailing comma",
      ["interface X { [k: string]: string }"],
      ["interface X { [k: string,]: string }"],
    ],
    [
      "a type-argument trailing comma",
      ["type X = Foo<string>;"],
      ["type X = Foo<string,>;"],
    ],
    [
      "a configuration-dependent dynamic-import trailing comma",
      ["export const value = import(\"value\");"],
      ["export const value = import(\"value\",);"],
    ],
    [
      "a line terminator before an arrow",
      ["export const f = () => 1;"],
      ["export const f = ()", "  => 1;"],
    ],
  ])("vetoes deferred TypeScript grammar error from %s", async (_label, baseLines, headLines) => {
    const root = sourceRoot();
    const path = "src/grammar.ts";
    writeSource(root, path, headLines);

    await expect(proveFormattingOnlyEdits(
      root,
      [replacement(path, 1, baseLines, headLines)],
      modified(path),
    )).resolves.toEqual({ version: 1, edits: [] });
  });

  it.each([
    ["identifier", "export const total = left + right;", "export const total = debit + right;"],
    ["literal", "export const limit = 10;", "export const limit = 11;"],
    ["operator", "export const enabled = left && right;", "export const enabled = left || right;"],
  ])("retains %s changes as semantic review work", async (_label, baseLine, headLine) => {
    const root = sourceRoot();
    const path = "src/value.ts";
    writeSource(root, path, [headLine]);

    await expect(proveFormattingOnlyEdits(
      root,
      [replacement(path, 1, [baseLine], [headLine])],
      modified(path),
    )).resolves.toEqual({ version: 1, edits: [] });
  });

  it("fails open when the HEAD full-file parse has a syntax error", async () => {
    const root = sourceRoot();
    const path = "src/broken.ts";
    writeSource(root, path, ["export const = 1;"]);

    await expect(proveFormattingOnlyEdits(
      root,
      [replacement(path, 1, ["export const =    1;"], ["export const = 1;"])],
      modified(path),
    )).resolves.toEqual({ version: 1, edits: [] });
  });

  it("fails open when the one-edit-reverted hybrid has a syntax error", async () => {
    const root = sourceRoot();
    const path = "src/hybrid-broken.ts";
    writeSource(root, path, ["export const value = 1;"]);

    await expect(proveFormattingOnlyEdits(
      root,
      [replacement(path, 1, ["export const = 1;"], ["export const value = 1;"])],
      modified(path),
    )).resolves.toEqual({ version: 1, edits: [] });
  });

  it("vetoes comments and directives inside the edit while allowing unchanged neighboring docs", async () => {
    const root = sourceRoot();
    const commentPath = "src/comment.ts";
    writeSource(root, commentPath, ["// unchanged docs", "export const value = 1; // retained"]);
    const directivePath = "src/directive.ts";
    writeSource(root, directivePath, ["\"use strict\";", "export const value = 1;"]);

    const proof = await proveFormattingOnlyEdits(
      root,
      [
        replacement(
          commentPath,
          2,
          ["export const value=1; // retained"],
          ["export const value = 1; // retained"],
        ),
        replacement(directivePath, 1, ["\"use strict\" ;"], ["\"use strict\";"]),
      ],
      [...modified(commentPath), ...modified(directivePath)],
    );

    expect(proof).toEqual({ version: 1, edits: [] });
  });

  it("vetoes an unchanged tool directive adjacent to an otherwise layout-only edit", async () => {
    const root = sourceRoot();
    const path = "src/ignored.ts";
    writeSource(root, path, ["// @ts-ignore", "export const value = 1;"]);

    await expect(proveFormattingOnlyEdits(
      root,
      [replacement(path, 2, ["export const value=1;"], ["export const value = 1;"])],
      modified(path),
    )).resolves.toEqual({ version: 1, edits: [] });
  });

  it("fails open for Python instead of approximating stdlib AST/tokenize semantics", async () => {
    const root = sourceRoot();
    const path = "src/app.py";
    writeSource(root, path, ["value = call(", "    first,", "    second,", ")"]);

    await expect(proveFormattingOnlyEdits(
      root,
      [replacement(path, 1, ["value = call(first, second)"], [
        "value = call(",
        "    first,",
        "    second,",
        ")",
      ])],
      modified(path),
    )).resolves.toEqual({ version: 1, edits: [] });
  });

  it("requires exact HEAD-side rows and never trusts coordinates alone", async () => {
    const root = sourceRoot();
    const path = "src/exact.ts";
    writeSource(root, path, ["export const value = 1;"]);
    const candidate = replacement(
      path,
      1,
      ["export const value=1;"],
      ["export const value = 1;"],
    );
    candidate.addedRows = [{ ...candidate.addedRows[0], text: "different bytes" }];

    await expect(proveFormattingOnlyEdits(root, [candidate], modified(path))).resolves.toEqual({
      version: 1,
      edits: [],
    });
  });

  it("emits only modified files and returns proof edits in canonical path/coordinate order", async () => {
    const root = sourceRoot();
    writeSource(root, "src/z.ts", ["export const z = 1;"]);
    writeSource(root, "src/a.ts", ["export const a = 1;"]);
    writeSource(root, "src/renamed.ts", ["export const renamed = 1;"]);

    const proof = await proveFormattingOnlyEdits(
      root,
      [
        replacement("src/z.ts", 1, ["export const z=1;"], ["export const z = 1;"]),
        replacement("src/renamed.ts", 1, ["export const renamed=1;"], ["export const renamed = 1;"]),
        replacement("src/a.ts", 1, ["export const a=1;"], ["export const a = 1;"]),
      ],
      [
        ...modified("src/z.ts"),
        { path: "src/renamed.ts", status: "renamed", previousPath: "src/old.ts" },
        ...modified("src/a.ts"),
      ],
    );

    expect(proof.edits.map((edit) => edit.path)).toEqual(["src/a.ts", "src/z.ts"]);
  });
});

function sourceRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "meridian-format-proof-"));
  temporaryDirectories.push(root);
  mkdirSync(join(root, "src"), { recursive: true });
  return root;
}

function writeSource(root: string, path: string, lines: readonly string[]): void {
  const absolute = join(root, path);
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, `${lines.join("\n")}\n`);
}

function modified(path: string): ChangedFileManifestEntry[] {
  return [{ path, status: "modified" }];
}

function replacement(
  path: string,
  start: number,
  deleted: readonly string[],
  added: readonly string[],
): FormattingProofCandidate {
  return {
    path,
    oldStart: start,
    oldLines: deleted.length,
    newStart: start,
    newLines: added.length,
    deletedRows: deleted.map((text, index): ChangedDiffLine => ({
      kind: "deleted",
      oldLine: start + index,
      newLine: null,
      beforeNewLine: start,
      text,
    })),
    addedRows: added.map((text, index): ChangedDiffLine => ({
      kind: "added",
      oldLine: null,
      newLine: start + index,
      beforeNewLine: start + index,
      text,
    })),
  };
}

function proofEdit(candidate: FormattingProofCandidate) {
  return {
    path: candidate.path,
    oldStart: candidate.oldStart,
    oldLines: candidate.oldLines,
    newStart: candidate.newStart,
    newLines: candidate.newLines,
    oldRows: candidate.deletedRows.map((row) => ({
      text: row.text,
      noNewline: row.noNewline === true,
    })),
    newRows: candidate.addedRows.map((row) => ({
      text: row.text,
      noNewline: row.noNewline === true,
    })),
  };
}
