/**
 * Give the memory-hungry commands headroom. Extracting a large monorepo holds a whole ts-morph
 * program (every source file's AST + type info) in heap and OOMs at Node's ~2–4 GB default ceiling.
 * Rather than make the user discover `NODE_OPTIONS=--max-old-space-size`, `generate`/`web` re-exec
 * themselves once with a larger old-space. Deterministic: the same ceiling every run, independent of
 * ambient env. Skipped when the ceiling is already generous or the user pinned one themselves, so a
 * plain `view`/`--version` never pays for an extra process.
 */

import { spawnSync } from "node:child_process";
import { getHeapStatistics } from "node:v8";

const RAISED_ENV = "MERIDIAN_HEAP_RAISED";
const HEAP_HUNGRY_COMMANDS = new Set(["generate", "web"]);
const TARGET_MB = 8192;
// Only raise when the ambient ceiling is below this — a user who set a bigger one keeps it.
const MIN_ACCEPTABLE_BYTES = 7000 * 1024 * 1024;

export function ensureHeadroom(argv: string[]): void {
  if (process.env[RAISED_ENV] === "1" || !needsHeadroom(argv)) {
    return;
  }
  const result = spawnSync(
    process.execPath,
    [`--max-old-space-size=${TARGET_MB}`, argv[1], ...argv.slice(2)],
    { stdio: "inherit", env: { ...process.env, [RAISED_ENV]: "1" } },
  );
  process.exit(result.status ?? 1);
}

function needsHeadroom(argv: string[]): boolean {
  const wantsHungryCommand = argv.slice(2).some((token) => HEAP_HUNGRY_COMMANDS.has(token));
  return wantsHungryCommand && getHeapStatistics().heap_size_limit < MIN_ACCEPTABLE_BYTES && !pinnedByUser();
}

function pinnedByUser(): boolean {
  return (process.env.NODE_OPTIONS ?? "").includes("--max-old-space-size");
}
