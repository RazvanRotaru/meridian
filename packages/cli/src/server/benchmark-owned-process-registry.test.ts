import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  BENCHMARK_OWNER_REGISTRY_ENV,
  BENCHMARK_OWNER_TOKEN_ENV,
  benchmarkGitOwnerArgs,
  benchmarkWorkerOwnerArgs,
  registerBenchmarkOwnedChild,
  terminateUnregisteredBenchmarkChild,
} from "./benchmark-owned-process-registry";

const roots: string[] = [];
const originalToken = process.env[BENCHMARK_OWNER_TOKEN_ENV];
const originalRegistry = process.env[BENCHMARK_OWNER_REGISTRY_ENV];
const originalTempDirectory = process.env.TMPDIR;
const originalTemp = process.env.TMP;
const originalTemporary = process.env.TEMP;

afterEach(async () => {
  restoreEnvironment(BENCHMARK_OWNER_TOKEN_ENV, originalToken);
  restoreEnvironment(BENCHMARK_OWNER_REGISTRY_ENV, originalRegistry);
  restoreEnvironment("TMPDIR", originalTempDirectory);
  restoreEnvironment("TMP", originalTemp);
  restoreEnvironment("TEMP", originalTemporary);
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("benchmark owned-process registry", () => {
  it("is inert when the isolated benchmark contract is absent", () => {
    delete process.env[BENCHMARK_OWNER_TOKEN_ENV];
    delete process.env[BENCHMARK_OWNER_REGISTRY_ENV];
    expect(benchmarkWorkerOwnerArgs()).toEqual([]);
    expect(benchmarkGitOwnerArgs()).toEqual([]);
    expect(() => registerBenchmarkOwnedChild(12_345)).not.toThrow();
  });

  it("preflights a private no-follow registry and appends only a token digest", () => {
    const { registry, token } = prepareRegistry();
    expect(benchmarkWorkerOwnerArgs()).toEqual([`--meridian-owner-token=${token}`]);
    expect(benchmarkGitOwnerArgs()).toEqual(["-c", `meridian.owner=${token}`]);

    registerBenchmarkOwnedChild(12_345);
    const text = readFileSync(registry, "utf8");
    const record = JSON.parse(text);
    expect(record).toMatchObject({
      version: 1,
      pid: 12_345,
      parentPid: process.pid,
      processGroupId: 12_345,
    });
    expect(record.tokenDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(text).not.toContain(token);
  });

  it("accepts the owned root itself when the isolated service pins its runtime temp directory", () => {
    const { registry, root, token } = prepareRegistry();
    process.env.TMPDIR = root;
    process.env.TMP = root;
    process.env.TEMP = root;

    expect(benchmarkWorkerOwnerArgs()).toEqual([`--meridian-owner-token=${token}`]);
    expect(benchmarkGitOwnerArgs()).toEqual(["-c", `meridian.owner=${token}`]);
    registerBenchmarkOwnedChild(12_346);
    expect(JSON.parse(readFileSync(registry, "utf8"))).toMatchObject({
      pid: 12_346,
      processGroupId: 12_346,
    });
  });

  it("rejects a symlink registry before a child is spawned", () => {
    const root = mkdtempSync(join(tmpdir(), "meridian-pr-review-cold-registry-test-"));
    roots.push(root);
    const target = join(root, "target.ndjson");
    writeFileSync(target, "", { mode: 0o600 });
    const registry = join(root, "owned-processes.ndjson");
    symlinkSync(target, registry);
    process.env[BENCHMARK_OWNER_TOKEN_ENV] = "c".repeat(64);
    process.env[BENCHMARK_OWNER_REGISTRY_ENV] = registry;

    expect(() => benchmarkWorkerOwnerArgs()).toThrow(/registry is not private/);
  });

  const unixIt = process.platform === "win32" ? it.skip : it;
  unixIt("kills, reaps, and proves an unregistered detached group absent", async () => {
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 60000)"], {
      detached: true,
      stdio: "ignore",
    });
    const pid = child.pid;
    expect(pid).toBeGreaterThan(1);
    await terminateUnregisteredBenchmarkChild(child);
    expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
    expect(() => process.kill(-(pid as number), 0)).toThrow(expect.objectContaining({ code: "ESRCH" }));
  });
});

function prepareRegistry(): { registry: string; root: string; token: string } {
  const root = mkdtempSync(join(tmpdir(), "meridian-pr-review-cold-registry-test-"));
  roots.push(root);
  const registry = join(root, "owned-processes.ndjson");
  const token = "b".repeat(64);
  writeFileSync(registry, "", { flag: "wx", mode: 0o600 });
  process.env[BENCHMARK_OWNER_TOKEN_ENV] = token;
  process.env[BENCHMARK_OWNER_REGISTRY_ENV] = registry;
  return { registry, root, token };
}

function restoreEnvironment(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
