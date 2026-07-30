import { describe, expect, it } from "vitest";
import { parseUnifiedDiffBody as parseUnifiedDiffBodyRaw } from "./unified-diff";
import { typescriptLineCommentProjections } from "./typescript-source-comments";

function parseUnifiedDiffBody(patch: string, file?: string) {
  return parseUnifiedDiffBodyRaw(patch, file, typescriptLineCommentProjections);
}

describe("parseUnifiedDiffBody", () => {
  it("uses correct 1-based cursors for a U0 insertion at the start of a file", () => {
    const parsed = parseUnifiedDiffBody("@@ -0,0 +1,2 @@\n+first\n+second");

    expect(parsed.complete).toBe(true);
    expect(parsed.edits).toEqual([{ oldStart: 1, oldLines: 0, newStart: 1, newLines: 2 }]);
    expect(parsed.diffLines).toEqual([
      { kind: "added", oldLine: null, newLine: 1, beforeNewLine: 1, text: "first" },
      { kind: "added", oldLine: null, newLine: 2, beforeNewLine: 2, text: "second" },
    ]);
    expect(parsed.ranges).toEqual([{ start: 1, end: 2 }]);
    expect(parsed.oldRanges).toEqual([{ start: 1, end: 1 }]);
  });

  it("anchors a U0 pure deletion to the next HEAD row without fabricating paintable rows", () => {
    const parsed = parseUnifiedDiffBody("@@ -3,2 +2,0 @@\n-old three\n-old four");

    expect(parsed.complete).toBe(true);
    expect(parsed.edits).toEqual([{ oldStart: 3, oldLines: 2, newStart: 3, newLines: 0 }]);
    expect(parsed.diffLines).toEqual([
      { kind: "deleted", oldLine: 3, newLine: null, beforeNewLine: 3, text: "old three" },
      { kind: "deleted", oldLine: 4, newLine: null, beforeNewLine: 3, text: "old four" },
    ]);
    expect(parsed.ranges).toEqual([{ start: 3, end: 3 }]);
    expect(parsed.oldRanges).toEqual([{ start: 3, end: 4 }]);
    expect(parsed.kinds).toEqual([]);
  });

  it("emits exact rows and one tight edit for a replacement with an unpaired addition", () => {
    const parsed = parseUnifiedDiffBody([
      "@@ -4,2 +4,3 @@",
      "-old one",
      "-old two",
      "+new one",
      "+new two",
      "+brand new",
    ].join("\n"));

    expect(parsed).toMatchObject({
      complete: true,
      added: 3,
      deleted: 2,
      ranges: [{ start: 4, end: 6 }],
      oldRanges: [{ start: 4, end: 5 }],
      edits: [{ oldStart: 4, oldLines: 2, newStart: 4, newLines: 3 }],
      kinds: [
        { start: 4, end: 5, kind: "modified" },
        { start: 6, end: 6, kind: "added" },
      ],
    });
    expect(parsed.diffLines.map((line) => line.text)).toEqual([
      "old one",
      "old two",
      "new one",
      "new two",
      "brand new",
    ]);
  });

  it("splits edits at context rows instead of reusing the context-padded hunk header", () => {
    const parsed = parseUnifiedDiffBody([
      "@@ -10,5 +10,5 @@",
      " context one",
      "-old a",
      "+new a",
      " middle",
      "-old b",
      "+new b",
      " context two",
    ].join("\n"));

    expect(parsed.complete).toBe(true);
    expect(parsed.edits).toEqual([
      { oldStart: 11, oldLines: 1, newStart: 11, newLines: 1 },
      { oldStart: 13, oldLines: 1, newStart: 13, newLines: 1 },
    ]);
  });

  it("marks a cut hunk incomplete while retaining the rows it could parse", () => {
    const parsed = parseUnifiedDiffBody("@@ -1,2 +1,2 @@\n-old\n+new");

    expect(parsed.complete).toBe(false);
    expect(parsed.diffLines).toHaveLength(2);
  });

  it("attaches Git's no-newline marker to the exact preceding changed side", () => {
    const parsed = parseUnifiedDiffBody([
      "@@ -1 +1 @@",
      "-old without newline",
      "\\ No newline at end of file",
      "+new without newline",
      "\\ No newline at end of file",
    ].join("\n"));

    expect(parsed.complete).toBe(true);
    expect(parsed.diffLines).toEqual([
      {
        kind: "deleted",
        oldLine: 1,
        newLine: null,
        beforeNewLine: 1,
        text: "old without newline",
        noNewline: true,
      },
      {
        kind: "added",
        oldLine: null,
        newLine: 1,
        beforeNewLine: 1,
        text: "new without newline",
        noNewline: true,
      },
    ]);
  });

  it("marks an unknown backslash row incomplete and withholds comment-only proof", () => {
    const parsed = parseUnifiedDiffBody([
      "@@ -1 +1 @@",
      "-// Old docs.",
      "\\ malformed marker",
      "+// New docs.",
    ].join("\n"), "src/provider.ts");

    expect(parsed.complete).toBe(false);
    expect(parsed.diffLines).toHaveLength(2);
    expect(parsed.diffLines.some(
      (line) => line.sourceCommentOnly === true || line.sourceCommentLineOnly === true,
    )).toBe(false);
  });

  it.each([
    {
      label: "adds an EOF newline",
      patch: [
        "@@ -1 +1 @@",
        "-// Old docs.",
        "\\ No newline at end of file",
        "+// New docs.",
      ],
    },
    {
      label: "removes an EOF newline",
      patch: [
        "@@ -1 +1 @@",
        "-// Old docs.",
        "+// New docs.",
        "\\ No newline at end of file",
      ],
    },
  ])("keeps a comment edit visible when it $label", ({ patch }) => {
    const parsed = parseUnifiedDiffBody(patch.join("\n"), "src/provider.ts");

    expect(parsed.complete).toBe(true);
    expect(parsed.diffLines.some((line) => line.sourceCommentOnly === true)).toBe(false);
    expect(parsed.diffLines.some((line) => line.sourceCommentLineOnly === true)).toBe(false);
  });

  it("still proves comment edits when both sides retain the same missing EOF newline", () => {
    const parsed = parseUnifiedDiffBody([
      "@@ -1 +1 @@",
      "-// Old docs.",
      "\\ No newline at end of file",
      "+// New docs.",
      "\\ No newline at end of file",
    ].join("\n"), "src/provider.ts");

    expect(parsed.diffLines.every((line) => line.sourceCommentOnly === true)).toBe(true);
    expect(parsed.diffLines.every((line) => line.sourceCommentLineOnly === true)).toBe(true);
  });

  it("proves a JSDoc-interior replacement from surrounding patch context", () => {
    const parsed = parseUnifiedDiffBody([
      "@@ -1,4 +1,4 @@",
      " /**",
      "  * Describes the provider.",
      "- * Old provider owns this.",
      "+ * New provider owns this.",
      "  */",
    ].join("\n"), "src/provider.ts");

    expect(parsed.complete).toBe(true);
    expect(parsed.diffLines).toEqual([
      {
        kind: "deleted",
        oldLine: 3,
        newLine: null,
        beforeNewLine: 3,
        text: " * Old provider owns this.",
        sourceCommentOnly: true,
        sourceCommentLineOnly: true,
      },
      {
        kind: "added",
        oldLine: null,
        newLine: 3,
        beforeNewLine: 3,
        text: " * New provider owns this.",
        sourceCommentOnly: true,
        sourceCommentLineOnly: true,
      },
    ]);
  });

  it("does not treat a bare asterisk in partial context as proof of a JSDoc", () => {
    const parsed = parseUnifiedDiffBody([
      "@@ -563,6 +563,6 @@ export async function postDecision",
      " * Launch a chat-based advisory review.",
      " *",
      " * Stores submission metadata in the pending store.",
      "- * PlatformContextProvider can inject it.",
      "+ * DelegateComputerUseContextProvider can inject it.",
      " * The caller must then launch the review session.",
      " * and navigate to chat.",
    ].join("\n"), "src/orchestratorService.ts");

    expect(parsed.complete).toBe(true);
    expect(parsed.diffLines.some((line) => line.sourceCommentOnly === true)).toBe(false);
  });

  it("proves a trailing-comment edit when the executable source is unchanged", () => {
    const parsed = parseUnifiedDiffBody([
      "@@ -1,3 +1,3 @@",
      " before();",
      "-value = null; // old provider consumed it",
      "+value = null; // new provider consumed it",
      " after();",
    ].join("\n"), "src/provider.tsx");

    expect(parsed.diffLines.every((line) => line.sourceCommentOnly === true)).toBe(true);
  });

  it("does not mistake JSX URL text for a source comment", () => {
    const parsed = parseUnifiedDiffBody([
      "@@ -1 +1 @@",
      "-const link = <a>https://old.example</a>;",
      "+const link = <a>https://new.example</a>;",
    ].join("\n"), "src/link.tsx");

    expect(parsed.diffLines.some((line) => line.sourceCommentOnly === true)).toBe(false);
  });

  it("does not mistake comment-shaped JSX text for source comments", () => {
    const parsed = parseUnifiedDiffBody([
      "@@ -1,3 +1,3 @@",
      " export const message = <div>",
      "-  // Old visible text",
      "+  // New visible text",
      " </div>;",
    ].join("\n"), "src/message.tsx");

    expect(parsed.diffLines.some((line) => line.sourceCommentOnly === true)).toBe(false);
  });

  it("preserves comment boundaries when comparing executable TypeScript tokens", () => {
    const parsed = parseUnifiedDiffBody([
      "@@ -1 +1 @@",
      "-const x = typeof/* old */foo;",
      "+const x = typeoffoo/* new */;",
    ].join("\n"), "src/provider.ts");

    expect(parsed.diffLines.some((line) => line.sourceCommentOnly === true)).toBe(false);
  });

  it("preserves ECMAScript line terminators inside changed block comments", () => {
    const parsed = parseUnifiedDiffBody([
      "@@ -1 +1 @@",
      "-return /* old */ value;",
      "+return /* new\u2028line */ value;",
    ].join("\n"), "src/provider.ts");

    expect(parsed.diffLines.some((line) => line.sourceCommentOnly === true)).toBe(false);
  });

  it("does not scan past ECMAScript line terminators when a trailing comment is added", () => {
    for (const terminator of ["\r", "\u2028", "\u2029"]) {
      const parsed = parseUnifiedDiffBody([
        "@@ -1 +1 @@",
        `-foo${terminator}bar`,
        `+foo/* docs */${terminator}bar`,
      ].join("\n"), "src/provider.ts");

      expect(parsed.diffLines.every((line) => line.sourceCommentOnly === true)).toBe(true);
    }
  });

  it("recognizes added prefix and trailing comments without changing source tokens", () => {
    const trailingTypeScript = parseUnifiedDiffBody([
      "@@ -1 +1 @@",
      "-return value;",
      "+return value; // explain the result",
    ].join("\n"), "src/provider.ts");
    const prefixTypeScript = parseUnifiedDiffBody([
      "@@ -1 +1 @@",
      "-factory();",
      "+/* preserve this call */ factory();",
    ].join("\n"), "src/provider.ts");
    const trailingPython = parseUnifiedDiffBody([
      "@@ -1 +1 @@",
      "-value = call()",
      "+value = call()  # explain the result",
    ].join("\n"), "tools/provider.py");

    expect(trailingTypeScript.diffLines.every((line) => line.sourceCommentOnly === true)).toBe(true);
    expect(prefixTypeScript.diffLines.every((line) => line.sourceCommentOnly === true)).toBe(true);
    expect(trailingPython.diffLines.every((line) => line.sourceCommentOnly === true)).toBe(true);
    expect(trailingTypeScript.diffLines.some((line) => line.sourceCommentLineOnly === true)).toBe(false);
    expect(prefixTypeScript.diffLines.some((line) => line.sourceCommentLineOnly === true)).toBe(false);
    expect(trailingPython.diffLines.some((line) => line.sourceCommentLineOnly === true)).toBe(false);
  });

  it("preserves whitespace-only rows inside TypeScript and Python string literals", () => {
    const typescript = parseUnifiedDiffBody([
      "@@ -1,4 +1,4 @@",
      " const message = `",
      "- ",
      "+  ",
      "-`; // old docs",
      "+`; // new docs",
      " consume(message);",
    ].join("\n"), "src/message.ts");
    const python = parseUnifiedDiffBody([
      "@@ -1,4 +1,4 @@",
      " message = \"\"\"",
      "- ",
      "+  ",
      "-\"\"\"  # old docs",
      "+\"\"\"  # new docs",
      " consume(message)",
    ].join("\n"), "tools/message.py");

    expect(typescript.diffLines.some((line) => line.sourceCommentOnly === true)).toBe(false);
    expect(python.diffLines.some((line) => line.sourceCommentOnly === true)).toBe(false);
  });

  it("recognizes a physically empty row inside a block comment", () => {
    const parsed = parseUnifiedDiffBody([
      "@@ -1,3 +1,3 @@",
      " /**",
      "-old docs",
      "+",
      "  */",
    ].join("\n"), "src/provider.ts");

    expect(parsed.diffLines.every((line) => line.sourceCommentOnly === true)).toBe(true);
  });

  it("proves a standalone line-comment row without treating adjacent added code as comment-only", () => {
    const parsed = parseUnifiedDiffBody([
      "@@ -0,0 +1,2 @@",
      "+// Explain the new helper.",
      "+export function helper() {}",
    ].join("\n"), "src/helper.ts");

    expect(parsed.diffLines).toEqual([
      {
        kind: "added",
        oldLine: null,
        newLine: 1,
        beforeNewLine: 1,
        text: "// Explain the new helper.",
        sourceCommentOnly: true,
        sourceCommentLineOnly: true,
      },
      {
        kind: "added",
        oldLine: null,
        newLine: 2,
        beforeNewLine: 2,
        text: "export function helper() {}",
      },
    ]);
  });

  it("keeps a block-comment delimiter edit that changes unchanged code's lexical ownership", () => {
    const parsed = parseUnifiedDiffBody([
      "@@ -1,2 +1,2 @@",
      "-/* Old docs. */",
      "+/* New docs.",
      " run();",
    ].join("\n"), "src/provider.ts");

    expect(parsed.diffLines.some((line) => line.sourceCommentOnly === true)).toBe(false);
    expect(parsed.diffLines.some((line) => line.sourceCommentLineOnly === true)).toBe(false);
  });

  it("keeps semantic compiler, tooling, and interpreter directives visible", () => {
    const cases = [
      {
        file: "src/types.ts",
        patch: ["@@ -1 +1 @@", '-/// <reference types="old" />', '+/// <reference types="new" />'],
      },
      {
        file: "src/check.ts",
        patch: ["@@ -1 +1 @@", "-// @ts-nocheck", "+// @ts-check"],
      },
      {
        file: "src/factory.ts",
        patch: ["@@ -1 +1 @@", "-const value = /*#__PURE__*/ factory();", "+const value = /* regular */ factory();"],
      },
      {
        file: "src/chunk.ts",
        patch: ["@@ -1 +1 @@", "-import(/* @vite-ignore */ oldPath);", "+import(/* @vite-ignore */ newPath);"],
      },
      {
        file: "src/api.ts",
        patch: ["@@ -1 +1 @@", "-/** @internal old contract */", "+/** @internal new contract */"],
      },
      {
        file: "src/types.js",
        patch: ["@@ -1 +1 @@", "-/** @param {string} value */", "+/** @param {number} value */"],
      },
      {
        file: "src/flow.js",
        patch: ["@@ -1 +1 @@", "-const value = /*: number */ 1;", "+const value = /*: string */ 1;"],
      },
      {
        file: "src/lazy.ts",
        patch: [
          "@@ -1 +1 @@",
          '-import(/* webpackChunkName: "old" */ "./feature");',
          '+import(/* webpackChunkName: "new" */ "./feature");',
        ],
      },
      {
        file: "src/inline.ts",
        patch: ["@@ -1 +1 @@", "-const value = /*#__INLINE__*/ call();", "+const value = /*#__NOINLINE__*/ call();"],
      },
      {
        file: "src/runtime.jsx",
        patch: ["@@ -1 +1 @@", "-/** @jsxRuntime classic */", "+/** @jsxRuntime automatic */"],
      },
      {
        file: "src/deno.ts",
        patch: ["@@ -1 +1 @@", '-// @deno-types="./old.d.ts"', '+// @deno-types="./new.d.ts"'],
      },
      {
        file: "src/deno-import.ts",
        patch: ["@@ -1 +1 @@", '-// @ts-types="./old.d.ts"', '+// @ts-types="./new.d.ts"'],
      },
      {
        file: "src/deno-package.js",
        patch: ["@@ -1 +1 @@", '-// @ts-self-types="./old.d.ts"', '+// @ts-self-types="./new.d.ts"'],
      },
      {
        file: "src/deno-format.ts",
        patch: ["@@ -1 +1 @@", "-// deno-fmt-ignore", "+// deno-fmt-ignore-file"],
      },
      {
        file: "src/deno-coverage.ts",
        patch: ["@@ -1 +1 @@", "-// deno-coverage-ignore", "+// deno-coverage-ignore-start"],
      },
      {
        file: "src/node-coverage.js",
        patch: ["@@ -1 +1 @@", "-/* node:coverage disable */", "+/* node:coverage enable */"],
      },
      {
        file: "src/mangle.ts",
        patch: [
          "@@ -1 +1 @@",
          "-const value = 1; /* ordinary comment */",
          "+const value = 1; /* @__MANGLE_PROP__ */",
        ],
      },
      {
        file: "src/key.ts",
        patch: [
          "@@ -1 +1 @@",
          "-const value = 1; /* @__KEY__ */",
          "+const value = 1; /* ordinary comment */",
        ],
      },
      {
        file: "src/environment.test.ts",
        patch: ["@@ -1 +1 @@", "-/** @jest-environment node */", "+/** @jest-environment jsdom */"],
      },
      {
        file: "src/angular.js",
        patch: ["@@ -1 +1 @@", "-/** @ngInject */", "+/** @ngNoInject */"],
      },
      {
        file: "src/wpt.js",
        patch: ["@@ -1 +1 @@", "-// META: global=window", "+// META: global=serviceworker"],
      },
      {
        file: "src/closure.js",
        patch: ["@@ -1 +1 @@", "-/** @define {boolean} */", "+/** @define {number} */"],
      },
      {
        file: "src/closure-collapse.js",
        patch: ["@@ -1 +1 @@", "-/** @nocollapse */", "+/** @export */"],
      },
      {
        file: "src/closure-const.js",
        patch: ["@@ -1 +1 @@", "-/** @const */", "+/** Ordinary docs. */"],
      },
      {
        file: "src/api-status.ts",
        patch: ["@@ -1 +1 @@", "-/** @alpha */", "+/** @beta */"],
      },
      {
        file: "src/license.js",
        patch: ["@@ -1 +1 @@", "-/** @license Old license text. */", "+/** @license New license text. */"],
      },
      {
        file: "src/banner.js",
        patch: ["@@ -1 +1 @@", "-/*! Old legal banner. */", "+/*! New legal banner. */"],
      },
      {
        file: "src/preserve.js",
        patch: ["@@ -1 +1 @@", "-/** @preserve old notice */", "+/** @preserve new notice */"],
      },
      {
        file: "src/legal.js",
        patch: ["@@ -1 +1 @@", "-//! Old legal text.", "+//! New legal text."],
      },
      {
        file: "src/semgrep.ts",
        patch: ["@@ -1 +1 @@", "-call(); // nosemgrep: old-rule", "+call(); // nosemgrep: new-rule"],
      },
      {
        file: "src/sonar.ts",
        patch: ["@@ -1 +1 @@", "-call(); // NOSONAR old", "+call(); // NOSONAR new"],
      },
      {
        file: "tools/check.py",
        patch: ["@@ -1 +1 @@", "-value = call()  # type: ignore[arg-type]", "+value = call()  # type: ignore[call-arg]"],
      },
      {
        file: "tools/types.py",
        patch: ["@@ -1 +1 @@", "-# type: list[int]", "+# type: list[str]"],
      },
      {
        file: "tools/imports.py",
        patch: ["@@ -1 +1 @@", "-import a  # isort: skip", "+import a  # isort: split"],
      },
      {
        file: "tools/run.py",
        patch: ["@@ -1 +1 @@", "-#!/usr/bin/env python3", "+#!/usr/bin/python3"],
      },
      {
        file: "tools/extension.py",
        patch: ["@@ -1 +1 @@", "-# cython: boundscheck=True", "+# cython: boundscheck=False"],
      },
      {
        file: "tools/setup.py",
        patch: ["@@ -1 +1 @@", "-# distutils: language=c", "+# distutils: language=c++"],
      },
      {
        file: "tools/pyre.py",
        patch: ["@@ -1 +1 @@", "-# pyre-strict", "+# pyre-unsafe"],
      },
      {
        file: "tools/pyre-inline.py",
        patch: ["@@ -1 +1 @@", "-call()  # pyre-ignore[7]", "+call()  # pyre-fixme[7]"],
      },
      {
        file: "tools/pythran.py",
        patch: ["@@ -1 +1 @@", "-# pythran export run(int)", "+# pythran export run(float)"],
      },
      {
        file: "tools/yapf.py",
        patch: ["@@ -1 +1 @@", "-# yapf: disable", "+# yapf: enable"],
      },
      {
        file: "tools/semgrep.py",
        patch: ["@@ -1 +1 @@", "-call()  # nosemgrep: old-rule", "+call()  # nosemgrep: new-rule"],
      },
      {
        file: "tools/sonar.py",
        patch: ["@@ -1 +1 @@", "-call()  # NOSONAR old", "+call()  # NOSONAR new"],
      },
    ];

    for (const { file, patch } of cases) {
      const parsed = parseUnifiedDiffBody(patch.join("\n"), file);
      expect(parsed.diffLines.some((line) => line.sourceCommentOnly === true), file).toBe(false);
    }
  });

  it("keeps ordinary documentation classifiable when it only mentions directive vocabulary", () => {
    const parsed = parseUnifiedDiffBody([
      "@@ -1 +1 @@",
      "-// Old notes about @ngInject, WPT META, Test262 features, licenses, and preservation.",
      "+// New notes about @ngInject, WPT META, Test262 features, licenses, and preservation.",
    ].join("\n"), "src/ordinary-docs.ts");

    expect(parsed.diffLines.every((line) => line.sourceCommentOnly === true)).toBe(true);
    expect(parsed.diffLines.every((line) => line.sourceCommentLineOnly === true)).toBe(true);
  });

  it("keeps a changed Test262 frontmatter row visible", () => {
    const parsed = parseUnifiedDiffBody([
      "@@ -1,6 +1,6 @@",
      " /*---",
      " features:",
      "-  - BigInt",
      "+  - Temporal",
      " ---*/",
      " ",
      " run();",
    ].join("\n"), "src/test262.js");

    expect(parsed.complete).toBe(true);
    expect(parsed.diffLines.some((line) => line.sourceCommentOnly === true)).toBe(false);
    expect(parsed.diffLines.some((line) => line.sourceCommentLineOnly === true)).toBe(false);
  });

  it("keeps arbitrary pragmas in the leading Jest docblock visible", () => {
    const parsed = parseUnifiedDiffBody([
      "@@ -1,3 +1,3 @@",
      " /**",
      "- * @my-custom-pragma old",
      "+ * @my-custom-pragma new",
      "  */",
    ].join("\n"), "src/environment.test.ts");

    expect(parsed.complete).toBe(true);
    expect(parsed.diffLines.some((line) => line.sourceCommentOnly === true)).toBe(false);
    expect(parsed.diffLines.some((line) => line.sourceCommentLineOnly === true)).toBe(false);
  });

  it("still classifies prose that merely mentions a custom pragma", () => {
    const parsed = parseUnifiedDiffBody([
      "@@ -1,4 +1,4 @@",
      " export const ready = true;",
      " /**",
      "- * Old documentation about @my-custom-pragma.",
      "+ * New documentation about @my-custom-pragma.",
      "  */",
    ].join("\n"), "src/provider.ts");

    expect(parsed.complete).toBe(true);
    expect(parsed.diffLines.every((line) => line.sourceCommentOnly === true)).toBe(true);
    expect(parsed.diffLines.every((line) => line.sourceCommentLineOnly === true)).toBe(true);
  });

  it("keeps an interior PEP 723 script-metadata edit visible", () => {
    const parsed = parseUnifiedDiffBody([
      "@@ -1,7 +1,7 @@",
      " # /// script",
      " # requires-python = \">=3.11\"",
      " # dependencies = [",
      "-#   \"requests<3\",",
      "+#   \"requests<4\",",
      " # ]",
      " # ///",
      " print(\"ready\")",
    ].join("\n"), "tools/bootstrap.py");

    expect(parsed.complete).toBe(true);
    expect(parsed.diffLines).toHaveLength(2);
    expect(parsed.diffLines.some((line) => line.sourceCommentOnly === true)).toBe(false);
    expect(parsed.diffLines.some((line) => line.sourceCommentLineOnly === true)).toBe(false);
  });

  it("still proves an ordinary Python comment edit outside a PEP 723 metadata block", () => {
    const parsed = parseUnifiedDiffBody([
      "@@ -1,8 +1,8 @@",
      " # /// script",
      " # requires-python = \">=3.11\"",
      " # dependencies = []",
      " # ///",
      " ",
      " print(\"ready\")",
      " ",
      "-# Old operational note.",
      "+# New operational note.",
    ].join("\n"), "tools/bootstrap.py");

    expect(parsed.complete).toBe(true);
    expect(parsed.diffLines.every((line) => line.sourceCommentOnly === true)).toBe(true);
    expect(parsed.diffLines.every((line) => line.sourceCommentLineOnly === true)).toBe(true);
  });

  it("keeps a changed continuation row in a Pythran export visible", () => {
    const parsed = parseUnifiedDiffBody([
      "@@ -1,2 +1,2 @@",
      " # pythran export run(int,",
      "-#                    float)",
      "+#                    double)",
    ].join("\n"), "tools/kernel.py");

    expect(parsed.complete).toBe(true);
    expect(parsed.diffLines.some((line) => line.sourceCommentOnly === true)).toBe(false);
    expect(parsed.diffLines.some((line) => line.sourceCommentLineOnly === true)).toBe(false);
  });

  it("still classifies an ordinary comment after a complete Pythran directive", () => {
    const parsed = parseUnifiedDiffBody([
      "@@ -1,3 +1,3 @@",
      " # pythran export run(int)",
      " ",
      "-# Old operational note.",
      "+# New operational note.",
    ].join("\n"), "tools/kernel.py");

    expect(parsed.complete).toBe(true);
    expect(parsed.diffLines.every((line) => line.sourceCommentOnly === true)).toBe(true);
    expect(parsed.diffLines.every((line) => line.sourceCommentLineOnly === true)).toBe(true);
  });

  it("keeps a changed row visible when its enclosing JSDoc block carries a semantic directive", () => {
    const parsed = parseUnifiedDiffBody([
      "@@ -1,6 +1,6 @@",
      " /**",
      "  * @type {{",
      "- *   a: string",
      "+ *   a: number",
      "  * }}",
      "  */",
      " const value = {};",
    ].join("\n"), "src/types.js");

    expect(parsed.complete).toBe(true);
    expect(parsed.diffLines.some((line) => line.sourceCommentOnly === true)).toBe(false);
  });

  it("fails open without aborting exact diff parsing when source nesting exceeds parser limits", () => {
    const nested = "(".repeat(1_200);
    const closed = ")".repeat(1_200);
    const parsed = parseUnifiedDiffBody([
      "@@ -1 +1 @@",
      `-const value = ${nested}1${closed}; // old docs`,
      `+const value = ${nested}1${closed}; // new docs`,
    ].join("\n"), "src/deep.ts");

    expect(parsed.complete).toBe(true);
    expect(parsed.diffLines).toHaveLength(2);
    expect(parsed.diffLines.some((line) => line.sourceCommentOnly === true)).toBe(false);
  });

  it("keeps exact rows but skips optional classification beyond the source-size budget", () => {
    const payload = "x".repeat(2 * 1024 * 1024);
    const parsed = parseUnifiedDiffBody([
      "@@ -1 +1 @@",
      `-const value = "${payload}"; // old docs`,
      `+const value = "${payload}"; // new docs`,
    ].join("\n"), "src/large.ts");

    expect(parsed.complete).toBe(true);
    expect(parsed.diffLines).toHaveLength(2);
    expect(parsed.diffLines.some((line) => line.sourceCommentOnly === true)).toBe(false);
  });

  it("fails open for a line comment when the patch begins in unknown lexical state", () => {
    const parsed = parseUnifiedDiffBody([
      "@@ -20 +20 @@",
      "-content // old text",
      "+content // new text",
    ].join("\n"), "src/template.ts");

    expect(parsed.diffLines.some((line) => line.sourceCommentOnly === true)).toBe(false);
  });

  it("keeps rows when code changes too or lexical context cannot prove a block comment", () => {
    const code = parseUnifiedDiffBody([
      "@@ -3 +3 @@",
      "-value = oldValue; // old provider",
      "+value = newValue; // new provider",
    ].join("\n"), "src/provider.ts");
    const ambiguousInterior = parseUnifiedDiffBody([
      "@@ -30 +30 @@",
      "- * Old docs.",
      "+ * New docs.",
    ].join("\n"), "src/provider.ts");

    expect(code.diffLines.some((line) => line.sourceCommentOnly === true)).toBe(false);
    expect(ambiguousInterior.diffLines.some((line) => line.sourceCommentOnly === true)).toBe(false);
  });

  it("keeps a trailing-comment edit when Python indentation also changes", () => {
    const parsed = parseUnifiedDiffBody([
      "@@ -3 +3 @@",
      "-  value = 1  # old docs",
      "+    value = 1  # new docs",
    ].join("\n"), "src/provider.py");

    expect(parsed.diffLines.some((line) => line.sourceCommentOnly === true)).toBe(false);
  });

  it("keeps a Python comment inserted after an explicit continuation visible", () => {
    const parsed = parseUnifiedDiffBody([
      "@@ -1,2 +1,3 @@",
      " x = 1 + \\",
      "+# inserted",
      " 2",
    ].join("\n"), "src/provider.py");

    expect(parsed.complete).toBe(true);
    expect(parsed.diffLines.some((line) => line.sourceCommentOnly === true)).toBe(false);
    expect(parsed.diffLines.some((line) => line.sourceCommentLineOnly === true)).toBe(false);
  });

  it("keeps Python 3.12 f-string replacement-expression string changes visible", () => {
    const parsed = parseUnifiedDiffBody([
      "@@ -1 +1 @@",
      '-value = f"{mapping["# old"]}"',
      '+value = f"{mapping["# new"]}"',
    ].join("\n"), "src/provider.py");

    expect(parsed.complete).toBe(true);
    expect(parsed.diffLines.some((line) => line.sourceCommentOnly === true)).toBe(false);
    expect(parsed.diffLines.some((line) => line.sourceCommentLineOnly === true)).toBe(false);
  });
});
