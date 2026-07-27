import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { startTypeScriptRevisionShardRetentionScheduler } from "./web-typescript-revision-shard-retention-scheduler";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("TypeScript shard retention scheduler", () => {
  it("runs an initial bounded pass and closes without leaving a timer owner", async () => {
    const cacheRoot = temporaryDirectory();
    let resolveReport!: () => void;
    const reported = new Promise<void>((resolve) => { resolveReport = resolve; });
    const scheduler = startTypeScriptRevisionShardRetentionScheduler({
      cacheRoot,
      initialDelayMs: 0,
      intervalMs: 60_000,
      onReport: (report) => {
        expect(report.status).toBe("completed");
        resolveReport();
      },
    });

    await reported;
    await scheduler.close();
    await scheduler.close();
  });

  it("rejects invalid scheduling intervals before allocating timers", () => {
    const cacheRoot = temporaryDirectory();
    expect(() => startTypeScriptRevisionShardRetentionScheduler({
      cacheRoot,
      initialDelayMs: -1,
    })).toThrow(/initial delay/);
    expect(() => startTypeScriptRevisionShardRetentionScheduler({
      cacheRoot,
      intervalMs: 0,
    })).toThrow(/interval/);
  });
});

function temporaryDirectory(): string {
  const root = mkdtempSync(join(tmpdir(), "meridian-shard-retention-scheduler-"));
  roots.push(root);
  return root;
}
