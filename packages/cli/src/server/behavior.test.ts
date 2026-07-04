/**
 * `collectBehavior` against a real throwaway git repo: argv-only spawn, repo-top re-rooting,
 * and the fail-soft contract (a non-repo directory disables behavior with a warning, never a
 * throw). Skipped wholesale when git is unavailable on the machine.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { collectBehavior } from "./behavior";

describe.skipIf(!gitAvailable())("collectBehavior", () => {
  let repo: string;

  beforeAll(() => {
    repo = mkdtempSync(join(tmpdir(), "meridian-behavior-"));
    git(repo, ["init", "-q"]);
    mkdirSync(join(repo, "src"));
    commitTouching(repo, ["src/a.ts", "src/b.ts"]);
    commitTouching(repo, ["src/a.ts", "src/b.ts"]);
    commitTouching(repo, ["src/a.ts", "src/b.ts"]);
    commitTouching(repo, ["src/a.ts"]);
  });

  afterAll(() => rmSync(repo, { recursive: true, force: true }));

  it("reports churn and a qualifying co-change pair from real history", async () => {
    const report = await collectBehavior(repo, 500, failOnWarn);
    expect(report).toMatchObject({ behaviorVersion: "1", commitsAnalyzed: 4 });
    expect(report?.churnByFile).toEqual({ "src/a.ts": 4, "src/b.ts": 3 });
    expect(report?.coChange).toEqual([{ a: "src/a.ts", b: "src/b.ts", count: 3, ratio: 1 }]);
  });

  it("re-roots paths when serving a subdirectory of the repository", async () => {
    const report = await collectBehavior(join(repo, "src"), 500, failOnWarn);
    expect(report?.churnByFile).toEqual({ "a.ts": 4, "b.ts": 3 });
  });

  it("honours the commit limit", async () => {
    const report = await collectBehavior(repo, 1, failOnWarn);
    expect(report?.commitsAnalyzed).toBe(1);
    expect(report?.churnByFile).toEqual({ "src/a.ts": 1 });
  });

  it("disables itself with a warning on a directory that is not a git repository", async () => {
    const plainDir = mkdtempSync(join(tmpdir(), "meridian-nogit-"));
    const warnings: string[] = [];
    const report = await collectBehavior(plainDir, 500, (line) => warnings.push(line));
    rmSync(plainDir, { recursive: true, force: true });
    expect(report).toBeNull();
    expect(warnings.join("\n")).toContain("behavior analysis disabled");
  });
});

function failOnWarn(line: string): void {
  throw new Error(`unexpected behavior warning: ${line}`);
}

function commitTouching(repo: string, files: string[]): void {
  for (const file of files) {
    writeFileSync(join(repo, file), `// ${Math.random()}\n`);
  }
  git(repo, ["add", "--", ...files]);
  git(repo, ["-c", "user.email=test@example.com", "-c", "user.name=test", "commit", "-q", "--no-gpg-sign", "-m", "touch"]);
}

function git(repo: string, args: string[]): void {
  execFileSync("git", args, { cwd: repo, stdio: "ignore", env: gitEnv() });
}

/** Isolate from the developer's global/system git config and hooks. */
function gitEnv(): NodeJS.ProcessEnv {
  return { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null", HOME: tmpdir() };
}

function gitAvailable(): boolean {
  try {
    execFileSync("git", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}
