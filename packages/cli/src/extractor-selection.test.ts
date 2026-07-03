/**
 * Regression: `generate` with no --lang must auto-detect the language from the source tree,
 * not fall back to a hard-coded default. Detection is filesystem-only (no interpreter spawn).
 */

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
  it("selects TypeScript for a tsconfig project", async () => {
    const extractor = await registry().select(join(REPO, "examples", "orders-service"));
    expect(extractor?.language).toBe("typescript");
  });

  it("selects Python for a pyproject/.py tree", async () => {
    const extractor = await registry().select(join(REPO, "examples", "orders-service-py"));
    expect(extractor?.language).toBe("python");
  });

  it("honors an explicit language over detection", async () => {
    const extractor = await registry().select(join(REPO, "examples", "orders-service"), "python");
    expect(extractor?.language).toBe("python");
  });
});
