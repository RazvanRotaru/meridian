import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  listGitTreeBlobs,
  verifyCleanCheckoutAtTree,
  verifyGitTreeInputs,
} from "./git-tree";

let root: string;
let treeOid: string;

function git(...args: string[]): string {
  return execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim();
}

function commit(message: string): void {
  git("add", "--all");
  git("commit", "-q", "-m", message);
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "meridian-git-tree-"));
  git("init", "-q");
  git("config", "user.name", "Meridian Test");
  git("config", "user.email", "meridian@example.test");
  mkdirSync(join(root, "src"));
  writeFileSync(join(root, "src", "index.ts"), "export const value = 1;\n");
  writeFileSync(join(root, "odd\tname.ts"), "x\n");
  commit("initial");
  treeOid = git("rev-parse", "HEAD^{tree}");
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("listGitTreeBlobs", () => {
  it("returns exact NUL-safe paths, object IDs, modes, and sizes", async () => {
    const entries = await listGitTreeBlobs(root, treeOid);

    expect(entries.map((entry) => entry.path)).toEqual(["odd\tname.ts", "src/index.ts"]);
    expect(entries.every((entry) => /^[0-9a-f]{40,64}$/.test(entry.oid))).toBe(true);
    expect(entries.map((entry) => entry.mode)).toEqual(["100644", "100644"]);
    expect(entries.map((entry) => entry.byteSize)).toEqual([2, 24]);
  });

  it("requires a full object ID", async () => {
    await expect(listGitTreeBlobs(root, treeOid.slice(0, 12))).rejects.toThrow(/exact/);
  });

  it("fails closed instead of omitting a gitlink", async () => {
    const commitOid = git("rev-parse", "HEAD");
    git("update-index", "--add", "--cacheinfo", `160000,${commitOid},vendor/submodule`);
    git("commit", "-q", "-m", "gitlink");
    const gitlinkTree = git("rev-parse", "HEAD^{tree}");

    await expect(listGitTreeBlobs(root, gitlinkTree)).rejects.toThrow(/Git commit entry/);
  });

  it("fingerprints a materialized tracked symlink to a tracked regular blob", async () => {
    writeFileSync(join(root, "src", "CLAUDE.md"), "rules\n");
    symlinkSync("CLAUDE.md", join(root, "src", "AGENTS.md"));
    commit("tracked link");
    const entries = await listGitTreeBlobs(root, git("rev-parse", "HEAD^{tree}"));

    const verified = await verifyGitTreeInputs(root, entries);

    expect(verified.regularBlobs.map((entry) => entry.path)).toEqual([
      "odd\tname.ts",
      "src/CLAUDE.md",
      "src/index.ts",
    ]);
    expect(verified.symlinks).toEqual([
      expect.objectContaining({
        path: "src/AGENTS.md",
        target: "CLAUDE.md",
        resolvedPath: "src/CLAUDE.md",
        resolvedMode: "100644",
      }),
    ]);
    expect(verified.symlinks[0]?.linkBlobOid).toMatch(/^[0-9a-f]{40,64}$/);
    expect(verified.symlinks[0]?.resolvedBlobOid).toMatch(/^[0-9a-f]{40,64}$/);
  });

  it("fails closed for escaping, dangling, or chained tracked symlinks", async () => {
    symlinkSync("../../outside", join(root, "src", "escape"));
    commit("escaping link");
    await expect(
      verifyGitTreeInputs(root, await listGitTreeBlobs(root, git("rev-parse", "HEAD^{tree}"))),
    ).rejects.toThrow(/escapes the repository/);

    unlinkSync(join(root, "src", "escape"));
    symlinkSync("missing", join(root, "src", "dangling"));
    commit("dangling link");
    await expect(
      verifyGitTreeInputs(root, await listGitTreeBlobs(root, git("rev-parse", "HEAD^{tree}"))),
    ).rejects.toThrow(/target is not in the exact Git tree/);

    unlinkSync(join(root, "src", "dangling"));
    symlinkSync("index.ts", join(root, "src", "first"));
    symlinkSync("first", join(root, "src", "second"));
    commit("chained link");
    await expect(
      verifyGitTreeInputs(root, await listGitTreeBlobs(root, git("rev-parse", "HEAD^{tree}"))),
    ).rejects.toThrow(/target is not a regular Git blob/);
  });
});

describe("verifyCleanCheckoutAtTree", () => {
  it("binds a clean checkout to its exact HEAD tree", async () => {
    const verified = await verifyCleanCheckoutAtTree(root, treeOid);

    expect(verified.expectedTreeOid).toBe(treeOid);
    expect(verified.headTreeOid).toBe(treeOid);
    expect(verified.headCommitOid).toBe(git("rev-parse", "HEAD"));
  });

  it("rejects tracked or untracked checkout changes", async () => {
    writeFileSync(join(root, "untracked.ts"), "export {};\n");
    await expect(verifyCleanCheckoutAtTree(root, treeOid)).rejects.toThrow(/not clean/);
  });

  it("rejects a clean HEAD at a different tree", async () => {
    writeFileSync(join(root, "src", "index.ts"), "export const value = 2;\n");
    commit("second");

    await expect(verifyCleanCheckoutAtTree(root, treeOid)).rejects.toThrow(/does not match/);
  });
});
