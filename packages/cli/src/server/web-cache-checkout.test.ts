import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runGit, runGitClone } from "./git-exec";
import { checkoutFor, repositoryCacheKey } from "./web-cache-checkout";
import type { GenerateRequest } from "./web-request";

vi.mock("./git-exec", () => ({
  runGit: vi.fn(),
  runGitClone: vi.fn(),
}));

const COMMIT = "a".repeat(40);
const REQUEST: GenerateRequest = { kind: "github", value: "owner/repo" };
const REMOTE_URL = "https://github.com/owner/repo.git";

let cacheRoot: string;

beforeEach(() => {
  cacheRoot = mkdtempSync(join(tmpdir(), "meridian-checkout-cutover-"));
  vi.mocked(runGit).mockImplementation(async (args) => (
    args[0] === "ls-remote" ? `${COMMIT}\tHEAD\n` : `${COMMIT}\n`
  ));
  vi.mocked(runGitClone).mockImplementation(async (args) => {
    mkdirSync(args.at(-1)!, { recursive: true });
  });
});

afterEach(() => {
  rmSync(cacheRoot, { recursive: true, force: true });
  vi.clearAllMocks();
});

describe("checkout cache format cutover", () => {
  it("treats noncurrent metadata as a miss and publishes the current format", async () => {
    const repositoryKey = repositoryCacheKey(REMOTE_URL);
    const entry = join(cacheRoot, "repositories", repositoryKey, COMMIT);
    mkdirSync(join(entry, "repo"), { recursive: true });
    writeFileSync(join(entry, "metadata.json"), JSON.stringify({
      formatVersion: 2,
      repositoryKey,
      commit: COMMIT,
      remoteUrl: REMOTE_URL,
    }));
    const onClone = vi.fn();

    const result = await checkoutFor(cacheRoot, REQUEST, cacheRoot, undefined, onClone);

    expect(result).toMatchObject({ cache: "miss", commit: COMMIT, repositoryKey, remoteUrl: REMOTE_URL });
    expect(onClone).toHaveBeenCalledTimes(1);
    expect(runGitClone).toHaveBeenCalledTimes(1);
    expect(JSON.parse(readFileSync(join(entry, "metadata.json"), "utf8"))).toMatchObject({
      formatVersion: 3,
      repositoryKey,
      commit: COMMIT,
      remoteUrl: REMOTE_URL,
    });
  });

  it("rejects a current-format source path that escapes the cache root", async () => {
    const repositoryKey = repositoryCacheKey(REMOTE_URL);
    const entry = join(cacheRoot, "repositories", repositoryKey, COMMIT);
    mkdirSync(entry, { recursive: true });
    writeFileSync(join(entry, "metadata.json"), JSON.stringify({
      formatVersion: 3,
      repositoryKey,
      commit: COMMIT,
      remoteUrl: REMOTE_URL,
      sourceRoot: "../outside",
    }));

    const result = await checkoutFor(cacheRoot, REQUEST, cacheRoot);

    expect(result.cache).toBe("miss");
    expect(result.repoDir).toBe(join(entry, "repo"));
    expect(runGitClone).toHaveBeenCalledTimes(1);
  });
});
