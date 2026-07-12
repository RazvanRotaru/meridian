/** Spawn the bundled stdlib analyzer with the newest project-compatible interpreter available. */

import { existsSync, readdirSync, type Dirent } from "node:fs";
import { delimiter, join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { ExtractOptions } from "@meridian/core";
import type { AnalyzeOutput } from "./types";

const ANALYZER_PATH = fileURLToPath(new URL("../python/analyze.py", import.meta.url));
const VERSIONED_INTERPRETERS = ["python3.14", "python3.13", "python3.12", "python3.11", "python3.10", "python3.9"];
const FALLBACK_INTERPRETERS = ["python3", "python"];
const MAX_OUTPUT_BYTES = 64 * 1024 * 1024;
const VENV_SEARCH_DEPTH = 4;
const SKIP_SEARCH_DIRS = new Set(["node_modules", "site-packages", "worktrees", "dist", "build", "out"]);
const VERSION_CACHE = new Map<string, number[] | null>();

export function runPythonAnalyzer(options: ExtractOptions): AnalyzeOutput {
  return parseOutput(spawnAnalyzer(options));
}

function spawnAnalyzer(options: ExtractOptions): string {
  const failures: string[] = [];
  const analyzerOptions = JSON.stringify({
    include: options.include ?? [],
    exclude: options.exclude ?? [],
    valueRefs: options.valueRefs ?? false,
  });
  for (const interpreter of interpreterCandidates(options.root)) {
    const result = spawnSync(interpreter, ["-S", ANALYZER_PATH, options.root, analyzerOptions], {
      encoding: "utf8",
      maxBuffer: MAX_OUTPUT_BYTES,
    });
    if (result.error) {
      if ((result.error as NodeJS.ErrnoException).code === "ENOENT") continue;
      failures.push(`${interpreter}: ${result.error.message}`);
      continue;
    }
    if (result.status === 0) return result.stdout;
    failures.push(`${interpreter}: exited with ${result.status}: ${result.stderr.trim()}`);
  }
  const detail = failures.length > 0 ? ` (${failures.join("; ")})` : "";
  throw new Error(`no usable Python interpreter found; the Python extractor needs Python 3.9+${detail}`);
}

function interpreterCandidates(root: string): string[] {
  const configured = process.env.MERIDIAN_PYTHON ? [process.env.MERIDIAN_PYTHON] : [];
  const versioned = VERSIONED_INTERPRETERS.filter(isAvailableInterpreter);
  const virtualEnvs = findVirtualEnvInterpreters(root);
  if (versioned.length > 0) return unique([...configured, ...versioned, ...virtualEnvs, ...FALLBACK_INTERPRETERS]);
  const discovered = unique([...FALLBACK_INTERPRETERS, ...virtualEnvs]);
  return unique([...configured, ...rankByVersion(discovered), ...discovered]);
}

function isAvailableInterpreter(interpreter: string): boolean {
  if (interpreter.includes("/") || interpreter.includes("\\")) return existsSync(interpreter);
  return (process.env.PATH ?? "")
    .split(delimiter)
    .some((directory) => directory.length > 0 && existsSync(join(directory, interpreter)));
}

function rankByVersion(interpreters: string[]): string[] {
  return interpreters
    .map((interpreter) => ({ interpreter, version: interpreterVersion(interpreter) }))
    .filter((candidate): candidate is { interpreter: string; version: number[] } => candidate.version !== null)
    .sort((left, right) => compareVersion(right.version, left.version))
    .map((candidate) => candidate.interpreter);
}

function interpreterVersion(interpreter: string): number[] | null {
  if (VERSION_CACHE.has(interpreter)) return VERSION_CACHE.get(interpreter) ?? null;
  const result = spawnSync(interpreter, ["-S", "-c", "import sys; print('.'.join(map(str, sys.version_info[:3])))"], {
    encoding: "utf8",
    timeout: 2_000,
  });
  if (result.error || result.status !== 0) {
    VERSION_CACHE.set(interpreter, null);
    return null;
  }
  const version = result.stdout.trim().split(".").map(Number);
  const parsed = version.length === 3 && version.every(Number.isFinite) ? version : null;
  VERSION_CACHE.set(interpreter, parsed);
  return parsed;
}

function compareVersion(left: number[], right: number[]): number {
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

function findVirtualEnvInterpreters(root: string): string[] {
  const found: string[] = [];
  visitForVirtualEnvs(root, VENV_SEARCH_DEPTH, found);
  return found;
}

function visitForVirtualEnvs(directory: string, depth: number, found: string[]): void {
  if (depth < 0) return;
  for (const entry of readEntries(directory)) {
    if (!entry.isDirectory()) continue;
    if (entry.name === ".venv" || entry.name === "venv") {
      addVirtualEnvInterpreter(join(directory, entry.name), found);
      continue;
    }
    if (entry.name.startsWith(".") || SKIP_SEARCH_DIRS.has(entry.name)) continue;
    visitForVirtualEnvs(join(directory, entry.name), depth - 1, found);
  }
}

function addVirtualEnvInterpreter(venv: string, found: string[]): void {
  const candidates = [join(venv, "bin", "python"), join(venv, "Scripts", "python.exe")];
  const interpreter = candidates.find((candidate) => existsSync(candidate));
  if (interpreter) found.push(interpreter);
}

function readEntries(directory: string): Dirent[] {
  try {
    return readdirSync(directory, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name));
  } catch {
    return [];
  }
}

function unique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

function parseOutput(stdout: string): AnalyzeOutput {
  try {
    return JSON.parse(stdout) as AnalyzeOutput;
  } catch (cause) {
    const reason = cause instanceof Error ? cause.message : String(cause);
    throw new Error(`could not parse analyzer output as JSON: ${reason}`);
  }
}
