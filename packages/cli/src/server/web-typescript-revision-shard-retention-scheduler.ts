import { resolve } from "node:path";
import {
  sweepTypeScriptRevisionShardCache,
  type TypeScriptRevisionShardRetentionPolicy,
  type TypeScriptRevisionShardRetentionReport,
} from "./web-typescript-revision-shard-retention";
import { tryWithTypeScriptRevisionShardBuildLock } from "./web-typescript-revision-shard-lock";

const DEFAULT_INITIAL_DELAY_MS = 60_000;
const DEFAULT_INTERVAL_MS = 60 * 60_000;

export interface TypeScriptRevisionShardRetentionSchedulerOptions {
  cacheRoot: string;
  policy?: Partial<TypeScriptRevisionShardRetentionPolicy>;
  initialDelayMs?: number;
  intervalMs?: number;
  onReport?(report: TypeScriptRevisionShardRetentionReport): void;
  onError?(error: unknown): void;
}

export interface TypeScriptRevisionShardRetentionScheduler {
  close(): Promise<void>;
}

/** Schedule bounded shard retention away from request work; a busy build makes a pass a no-op. */
export function startTypeScriptRevisionShardRetentionScheduler(
  options: TypeScriptRevisionShardRetentionSchedulerOptions,
): TypeScriptRevisionShardRetentionScheduler {
  const cacheRoot = resolve(options.cacheRoot);
  const cacheDir = resolve(
    cacheRoot,
    "typescript-revision-shards-v1",
    "shadow-admitted",
  );
  const initialDelayMs = nonNegativeDelay(
    options.initialDelayMs,
    DEFAULT_INITIAL_DELAY_MS,
    "TypeScript shard retention initial delay",
  );
  const intervalMs = positiveDelay(
    options.intervalMs,
    DEFAULT_INTERVAL_MS,
    "TypeScript shard retention interval",
  );
  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  let active: Promise<void> | undefined;
  let closed = false;

  const schedule = (delayMs: number): void => {
    if (closed) return;
    timer = setTimeout(() => {
      timer = undefined;
      active = run().finally(() => {
        active = undefined;
        schedule(intervalMs);
      });
    }, delayMs);
    timer.unref();
  };
  const run = async (): Promise<void> => {
    try {
      const report = await sweepTypeScriptRevisionShardCache({
        cacheDir,
        policy: options.policy,
        signal: controller.signal,
        exclusive: (operation) => tryWithTypeScriptRevisionShardBuildLock(
          cacheRoot,
          controller.signal,
          async () => operation(),
        ),
      });
      options.onReport?.(report);
    } catch (error) {
      if (!controller.signal.aborted) options.onError?.(error);
    }
  };

  schedule(initialDelayMs);
  return {
    async close(): Promise<void> {
      if (closed) {
        await active;
        return;
      }
      closed = true;
      controller.abort();
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
      await active;
    },
  };
}

function nonNegativeDelay(
  value: number | undefined,
  fallback: number,
  name: string,
): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved < 0) {
    throw new RangeError(`${name} must be a non-negative safe integer`);
  }
  return resolved;
}

function positiveDelay(
  value: number | undefined,
  fallback: number,
  name: string,
): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved <= 0) {
    throw new RangeError(`${name} must be a positive safe integer`);
  }
  return resolved;
}
