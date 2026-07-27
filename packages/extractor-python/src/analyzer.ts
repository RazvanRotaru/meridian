/** Spawn the bundled stdlib analyzer with the newest project-compatible interpreter available. */

import { existsSync, readdirSync, type Dirent } from "node:fs";
import { delimiter, join } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { fileURLToPath } from "node:url";
import type { ExtractOptions } from "@meridian/core";
import { reportExtractionProgress } from "./progress";
import type { AnalyzeOutput } from "./types";

const ANALYZER_PATH = fileURLToPath(new URL("../python/analyze.py", import.meta.url));
const VERSIONED_INTERPRETERS = ["python3.14", "python3.13", "python3.12", "python3.11", "python3.10", "python3.9"];
const FALLBACK_INTERPRETERS = ["python3", "python"];
const MAX_OUTPUT_BYTES = 64 * 1024 * 1024;
const PROGRESS_PREFIX = "MERIDIAN_PROGRESS\t";
const MAX_STDERR_LINE_CHARS = 64 * 1024;
export const ANALYZER_DIAGNOSTIC_TAIL_CHARS = 64 * 1024;
const VENV_SEARCH_DEPTH = 4;
const SKIP_SEARCH_DIRS = new Set(["node_modules", "site-packages", "worktrees", "dist", "build", "out"]);
const VERSION_CACHE = new Map<string, number[] | null>();

export interface AnalyzerAttempt {
  kind: "success" | "missing" | "failure" | "output-overflow";
  stdout?: string;
  failure?: string;
}

export interface AnalyzerProcess {
  stdout: NodeJS.ReadableStream;
  stderr: NodeJS.ReadableStream;
  kill(): boolean;
  once(event: "error", listener: (error: NodeJS.ErrnoException) => void): unknown;
  once(event: "close", listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown;
}

interface AnalyzerProgress {
  phase: "project-load" | "structure";
  current?: number;
  total?: number;
  path?: string;
}

export async function runPythonAnalyzer(options: ExtractOptions): Promise<AnalyzeOutput> {
  return parseOutput(await spawnAnalyzer(options));
}

async function spawnAnalyzer(options: ExtractOptions): Promise<string> {
  const analyzerOptions = JSON.stringify({
    include: options.include ?? [],
    exclude: options.exclude ?? [],
    valueRefs: options.valueRefs ?? false,
    progress: options.onProgress !== undefined,
  });
  return runAnalyzerCandidates(
    interpreterCandidates(options.root),
    (interpreter) => executeAnalyzer(interpreter, options, analyzerOptions),
  );
}

/** Retry interpreter-specific failures, but never repeat extraction after a deterministic cap. */
export async function runAnalyzerCandidates(
  interpreters: readonly string[],
  execute: (interpreter: string) => Promise<AnalyzerAttempt>,
): Promise<string> {
  const failures: string[] = [];
  for (const interpreter of interpreters) {
    const attempt = await execute(interpreter);
    if (attempt.kind === "missing") {
      continue;
    }
    if (attempt.kind === "success") {
      return attempt.stdout ?? "";
    }
    if (attempt.kind === "output-overflow") {
      throw new Error(`Python analyzer output limit exceeded (${interpreter}: ${attempt.failure ?? "unknown failure"})`);
    }
    failures.push(`${interpreter}: ${attempt.failure ?? "unknown failure"}`);
  }
  const detail = failures.length > 0 ? ` (${failures.join("; ")})` : "";
  throw new Error(`no usable Python interpreter found; the Python extractor needs Python 3.9+${detail}`);
}

function executeAnalyzer(
  interpreter: string,
  options: ExtractOptions,
  analyzerOptions: string,
): Promise<AnalyzerAttempt> {
  let child;
  try {
    child = spawn(interpreter, ["-S", ANALYZER_PATH, options.root, analyzerOptions], {
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (cause) {
    const reason = cause instanceof Error ? cause.message : String(cause);
    return Promise.resolve({ kind: "failure", failure: reason });
  }
  return collectAnalyzerProcess(child as AnalyzerProcess, options);
}

/**
 * Drain one spawned analyzer through `close`. A child `error` is only recorded: in particular,
 * a failed kill after stdout overflow must not start an interpreter fallback while this process
 * still owns live stdio streams.
 */
export function collectAnalyzerProcess(
  child: AnalyzerProcess,
  options: ExtractOptions,
  maxOutputBytes = MAX_OUTPUT_BYTES,
): Promise<AnalyzerAttempt> {
  return new Promise((resolve) => {
    const stderr = createAnalyzerStderrParser(options);
    const stdoutChunks: Buffer[] = [];
    let stdoutBytes = 0;
    let stdoutOverflow = false;
    let childError: NodeJS.ErrnoException | null = null;
    child.stdout.on("data", (chunk: Buffer) => {
      if (stdoutOverflow) return;
      if (stdoutBytes + chunk.byteLength > maxOutputBytes) {
        stdoutOverflow = true;
        stdoutChunks.length = 0;
        stdoutBytes = 0;
        child.kill();
        return;
      }
      stdoutBytes += chunk.byteLength;
      stdoutChunks.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.once("error", (error: NodeJS.ErrnoException) => {
      childError ??= error;
    });
    child.once("close", (code, signal) => {
      const detail = stderr.finish().trim();
      if (childError?.code === "ENOENT" && !stdoutOverflow) {
        resolve({ kind: "missing" });
        return;
      }
      if (stdoutOverflow) {
        resolve({ kind: "output-overflow", failure: `stdout exceeded ${maxOutputBytes} bytes` });
        return;
      }
      if (childError) {
        resolve({ kind: "failure", failure: childError.message });
        return;
      }
      if (code === 0) {
        resolve({
          kind: "success",
          stdout: Buffer.concat(stdoutChunks, stdoutBytes).toString("utf8"),
        });
        return;
      }
      const status = code === null
        ? `terminated by signal ${signal ?? "unknown"}`
        : `exited with ${code}`;
      resolve({ kind: "failure", failure: detail ? `${status}: ${detail}` : status });
    });
  });
}

export interface AnalyzerStderrParser {
  push(chunk: Uint8Array): void;
  /** Flush decoding state and return only the bounded non-progress diagnostic tail. */
  finish(): string;
}

/**
 * Incrementally separate private progress frames from analyzer diagnostics. A missing newline or
 * malformed frame cannot retain more than one bounded line plus the bounded diagnostic tail.
 */
export function createAnalyzerStderrParser(options: ExtractOptions): AnalyzerStderrParser {
  const decoder = new StringDecoder("utf8");
  const diagnostics = new BoundedTextTail(ANALYZER_DIAGNOSTIC_TAIL_CHARS);
  let pendingLine = "";
  let overlongLine = false;
  let finished = false;

  const appendFragment = (fragment: string) => {
    if (overlongLine) {
      diagnostics.append(fragment);
      return;
    }
    if (pendingLine.length + fragment.length <= MAX_STDERR_LINE_CHARS) {
      pendingLine += fragment;
      return;
    }
    const available = Math.max(0, MAX_STDERR_LINE_CHARS - pendingLine.length);
    pendingLine += fragment.slice(0, available);
    diagnostics.append(pendingLine);
    diagnostics.append(fragment.slice(available));
    pendingLine = "";
    overlongLine = true;
  };

  const completeLine = (newline: boolean) => {
    if (overlongLine) {
      if (newline) diagnostics.append("\n");
      overlongLine = false;
      return;
    }
    const raw = pendingLine;
    pendingLine = "";
    const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    if (!reportAnalyzerProgress(options, line)) {
      diagnostics.append(raw);
      if (newline) diagnostics.append("\n");
    }
  };

  const consume = (text: string) => {
    let start = 0;
    while (start < text.length) {
      const newline = text.indexOf("\n", start);
      if (newline === -1) {
        appendFragment(text.slice(start));
        return;
      }
      appendFragment(text.slice(start, newline));
      completeLine(true);
      start = newline + 1;
    }
  };

  return {
    push: (chunk) => {
      if (finished) return;
      consume(decoder.write(Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength)));
    },
    finish: () => {
      if (!finished) {
        consume(decoder.end());
        if (pendingLine || overlongLine) completeLine(false);
        finished = true;
      }
      return diagnostics.value();
    },
  };
}

class BoundedTextTail {
  private text = "";

  constructor(private readonly maxChars: number) {}

  append(value: string): void {
    if (!value) return;
    if (value.length >= this.maxChars) {
      this.text = value.slice(-this.maxChars);
      return;
    }
    this.text += value;
    if (this.text.length > this.maxChars) {
      this.text = this.text.slice(-this.maxChars);
    }
  }

  value(): string {
    return this.text;
  }
}

/** Return true only for a recognized valid progress frame, which callers may safely discard. */
function reportAnalyzerProgress(options: ExtractOptions, line: string): boolean {
  if (!line.startsWith(PROGRESS_PREFIX)) return false;
  let candidate: unknown;
  try {
    candidate = JSON.parse(line.slice(PROGRESS_PREFIX.length));
  } catch {
    return false;
  }
  if (!isAnalyzerProgress(candidate)) return false;
  const unit = { current: 1, total: 1, path: "." };
  reportExtractionProgress(options, {
    language: "python",
    phase: candidate.phase,
    unit,
    sourceFile: candidate.path === undefined
      ? null
      : { current: candidate.current as number, total: candidate.total as number, path: candidate.path },
  });
  return true;
}

function isAnalyzerProgress(value: unknown): value is AnalyzerProgress {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<AnalyzerProgress>;
  if (candidate.phase !== "project-load" && candidate.phase !== "structure") return false;
  const hasPosition = candidate.current !== undefined || candidate.total !== undefined || candidate.path !== undefined;
  if (!hasPosition) return true;
  return (
    Number.isInteger(candidate.current)
    && Number.isInteger(candidate.total)
    && (candidate.current as number) >= 1
    && (candidate.total as number) >= (candidate.current as number)
    && typeof candidate.path === "string"
  );
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
