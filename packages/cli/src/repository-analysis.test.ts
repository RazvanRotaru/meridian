/** The product has one repository-analysis policy, regardless of transport or output destination. */

import { describe, expect, it, vi } from "vitest";
import { extractToArtifact } from "./extract-pipeline";
import {
  analyzeRepository,
  REPOSITORY_ANALYSIS_POLICY,
  REPOSITORY_ANALYSIS_VERSION,
} from "./repository-analysis";

vi.mock("./extract-pipeline", () => ({ extractToArtifact: vi.fn() }));

describe("canonical repository analysis", () => {
  it("uses one frozen workspace policy without a project or include escape hatch", async () => {
    vi.mocked(extractToArtifact).mockResolvedValue({ artifact: {}, warnings: [] } as never);

    await analyzeRepository({
      absoluteRoot: "/repo",
      cwd: "/repo",
      targetName: "repo",
      changedSince: "origin/main",
      hintedFiles: ["src/app.ts", "workers/job.py"],
      allowEmpty: true,
    });

    expect(Object.isFrozen(REPOSITORY_ANALYSIS_POLICY)).toBe(true);
    // Version 12 invalidates persisted partial slices whose target language varied with whichever
    // parser happened to produce files in that individual slice.
    expect(REPOSITORY_ANALYSIS_VERSION).toBe(13);
    expect(extractToArtifact).toHaveBeenCalledWith({
      absoluteRoot: "/repo",
      cwd: "/repo",
      depth: "function",
      includeExternal: true,
      includeUnresolved: false,
      materializeBoundary: true,
      excludeTests: false,
      valueRefs: true,
      changedSince: "origin/main",
      changedSinceTimeoutMs: undefined,
      changedSinceGitExecutor: undefined,
      hintedFiles: ["src/app.ts", "workers/job.py"],
      allowEmpty: true,
      targetName: "repo",
      vcs: undefined,
      typeScriptRevisionShards: undefined,
    });
    const request = vi.mocked(extractToArtifact).mock.calls[0][0];
    expect(request).not.toHaveProperty("language");
    expect(request).not.toHaveProperty("project");
    expect(request).not.toHaveProperty("include");
  });
});
