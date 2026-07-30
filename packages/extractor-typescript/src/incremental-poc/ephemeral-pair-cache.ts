/**
 * Request-scoped singleflight for two exact-revision workers.
 *
 * The enclosing PR-analysis owner creates and later removes the private cache directory, drains
 * both workers on failure, and never reuses this directory across requests. A lock abandoned by a
 * terminated worker therefore cannot be observed by a later analysis.
 */

import {
  mkdir,
  rmdir,
} from "node:fs/promises";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const RETRY_MS = 20;
const ADDRESS = /^[a-f0-9]{64}$/;

export async function withEphemeralPairUnitLock<Result>(
  pairCacheDir: string,
  baseInputKey: string,
  work: () => Result | Promise<Result>,
): Promise<Result> {
  if (!ADDRESS.test(baseInputKey)) {
    throw new TypeError("ephemeral pair unit lock requires a lowercase SHA-256 input key");
  }
  const locksRoot = resolve(pairCacheDir, "unit-locks");
  await mkdir(locksRoot, { recursive: true, mode: 0o700 });
  const lockDirectory = resolve(locksRoot, baseInputKey);

  while (true) {
    try {
      await mkdir(lockDirectory, { mode: 0o700 });
      break;
    } catch (error) {
      if (errorCode(error) !== "EEXIST") throw error;
      await delay(RETRY_MS);
    }
  }

  let completed = false;
  try {
    const result = await work();
    completed = true;
    return result;
  } finally {
    try {
      await rmdir(lockDirectory);
    } catch (error) {
      if (completed) throw error;
    }
  }
}

function errorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error
    ? String((error as { code?: unknown }).code)
    : undefined;
}
