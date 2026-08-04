/**
 * Benchmark-only ownership registration for detached worker/Git process-group leaders.
 *
 * The normal application never sets these two variables, so this is a no-op outside an isolated
 * PR-review benchmark service. The random marker is deliberately non-secret. The registry stores
 * only its digest and process metadata; cleanup resolves the immutable OS start token separately.
 */

import { createHash } from "node:crypto";
import type { ChildProcess } from "node:child_process";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, resolve } from "node:path";

export const BENCHMARK_OWNER_TOKEN_ENV = "MERIDIAN_BENCHMARK_OWNER_TOKEN";
export const BENCHMARK_OWNER_REGISTRY_ENV = "MERIDIAN_BENCHMARK_OWNER_REGISTRY";

export function benchmarkWorkerOwnerArgs(): string[] {
  const config = benchmarkOwnerConfig();
  if (config === null) return [];
  validatePrivateRegistry(validateRegistryPath(config.registryPath));
  return [`--meridian-owner-token=${config.token}`];
}

export function benchmarkGitOwnerArgs(): string[] {
  const config = benchmarkOwnerConfig();
  if (config === null) return [];
  validatePrivateRegistry(validateRegistryPath(config.registryPath));
  return ["-c", `meridian.owner=${config.token}`];
}

/** Append one detached child leader before its caller can consider the spawn ready. */
export function registerBenchmarkOwnedChild(pid: number, processGroupId = pid): void {
  const config = benchmarkOwnerConfig();
  if (config === null) return;
  if (process.platform === "win32") return;
  if (!Number.isSafeInteger(pid) || pid <= 1
    || !Number.isSafeInteger(processGroupId) || processGroupId !== pid) {
    throw new Error("benchmark owned child has no safe process identity");
  }
  const path = validateRegistryPath(config.registryPath);
  validatePrivateRegistry(path);
  const record = `${JSON.stringify({
    version: 1,
    tokenDigest: createHash("sha256").update(config.token).digest("hex"),
    pid,
    parentPid: process.pid,
    processGroupId,
  })}\n`;
  if (Buffer.byteLength(record) > 512) throw new Error("benchmark owned child record is too large");

  const noFollow = constants.O_NOFOLLOW ?? 0;
  const descriptor = openSync(path, constants.O_WRONLY | constants.O_APPEND | noFollow);
  try {
    const opened = fstatSync(descriptor);
    if (!opened.isFile()
      || opened.size > 1024 * 1024 - Buffer.byteLength(record)
      || (opened.mode & 0o077) !== 0
      || (typeof process.getuid === "function" && opened.uid !== process.getuid())) {
      throw new Error("benchmark owned process registry is not a private regular file");
    }
    const written = writeSync(descriptor, record, null, "utf8");
    if (written !== Buffer.byteLength(record)) {
      throw new Error("benchmark owned process registry append was incomplete");
    }
  } finally {
    closeSync(descriptor);
  }
}

/** Registration failed after spawn: synchronously signal, then await reaping and group absence. */
export async function terminateUnregisteredBenchmarkChild(child: ChildProcess): Promise<void> {
  const pid = child.pid;
  const completion = new Promise<void>((resolveCompletion) => {
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      child.off("exit", finish);
      child.off("error", finish);
      resolveCompletion();
    };
    const timer = setTimeout(finish, 1_000);
    child.once("exit", finish);
    child.once("error", finish);
    if (child.exitCode !== null || child.signalCode !== null) finish();
  });
  try {
    if (pid && process.platform !== "win32") process.kill(-pid, "SIGKILL");
    else child.kill("SIGKILL");
  } catch {
    child.kill("SIGKILL");
  }
  await completion;
  if (!pid || process.platform === "win32") return;
  const deadline = Date.now() + 1_000;
  for (;;) {
    let present = true;
    try { process.kill(-pid, 0); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") present = false;
      else throw error;
    }
    if (!present) return;
    if (Date.now() >= deadline) {
      throw new Error("unregistered benchmark child process group did not stop");
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 25));
  }
}

function benchmarkOwnerConfig(): { token: string; registryPath: string } | null {
  const token = process.env[BENCHMARK_OWNER_TOKEN_ENV];
  const registryPath = process.env[BENCHMARK_OWNER_REGISTRY_ENV];
  if (token === undefined && registryPath === undefined) return null;
  if (typeof token !== "string"
    || !/^[a-f0-9]{32,128}$/.test(token)
    || typeof registryPath !== "string"
    || registryPath.length === 0) {
    throw new Error("benchmark owned process configuration is incomplete");
  }
  return { token, registryPath };
}

function validateRegistryPath(value: string): string {
  const path = resolve(value);
  const directory = dirname(path);
  const runtimeTempDirectory = resolve(tmpdir());
  const directoryHasExpectedLocation = directory === runtimeTempDirectory
    || dirname(directory) === runtimeTempDirectory;
  if (basename(path) !== "owned-processes.ndjson"
    || !directoryHasExpectedLocation
    || !basename(directory).startsWith("meridian-pr-review-cold-")) {
    throw new Error("benchmark owned process registry path is outside its private cold root");
  }
  return path;
}

function validatePrivateRegistry(path: string): void {
  const directory = lstatSync(dirname(path));
  const file = lstatSync(path);
  const wrongOwner = typeof process.getuid === "function"
    && (directory.uid !== process.getuid() || file.uid !== process.getuid());
  if (!directory.isDirectory()
    || directory.isSymbolicLink()
    || (directory.mode & 0o077) !== 0
    || !file.isFile()
    || file.isSymbolicLink()
    || (file.mode & 0o077) !== 0
    || wrongOwner) {
    throw new Error("benchmark owned process registry is not private");
  }
}
