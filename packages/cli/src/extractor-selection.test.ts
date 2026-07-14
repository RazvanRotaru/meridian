/**
 * Repository analysis discovers every supported language in the source tree. Detection is
 * filesystem-only (no interpreter spawn), and registration order must not turn a polyglot repo
 * into a single-language graph.
 */

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ExtractorRegistry } from "@meridian/core";
import { TypeScriptExtractor } from "@meridian/extractor-typescript";
import { PythonExtractor } from "@meridian/extractor-python";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

function registry(): ExtractorRegistry {
  return new ExtractorRegistry().register(new TypeScriptExtractor()).register(new PythonExtractor());
}

describe("extractor auto-detection", () => {
  it("matches only TypeScript for a tsconfig project", async () => {
    const extractors = await registry().matching(join(REPO, "examples", "orders-service"));
    expect(extractors.map((extractor) => extractor.language)).toEqual(["typescript"]);
  });

  it("matches only Python for a pyproject/.py tree", async () => {
    const extractors = await registry().matching(join(REPO, "examples", "orders-service-py"));
    expect(extractors.map((extractor) => extractor.language)).toEqual(["python"]);
  });

  it("matches every detected extractor for a polyglot repository", async () => {
    const extractors = await registry().matching(REPO);
    expect(extractors.map((extractor) => extractor.language)).toEqual(["typescript", "python"]);
  });

  it("finds every language even when its first source file is deeply nested", async () => {
    const root = await mkdtemp(join(tmpdir(), "meridian-detect-deep-"));
    try {
      const pythonDir = join(root, "products", "risk", "services", "internal", "engines", "rules", "v1");
      await mkdir(pythonDir, { recursive: true });
      await writeFile(join(root, "index.ts"), "export const ready = true;\n");
      await writeFile(join(pythonDir, "score.py"), "def score():\n    return 1\n");

      const extractors = await registry().matching(root);
      expect(extractors.map((extractor) => extractor.language)).toEqual(["typescript", "python"]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
