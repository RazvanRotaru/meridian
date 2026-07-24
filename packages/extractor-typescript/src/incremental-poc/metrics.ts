import { lstatSync, readdirSync } from "node:fs";
import { join } from "node:path";

export function elapsedMs(start: bigint): number {
  return Number(process.hrtime.bigint() - start) / 1_000_000;
}

/** Node reports maxRSS in KiB on supported POSIX platforms. */
export function peakRssBytes(): number {
  return process.resourceUsage().maxRSS * 1024;
}

export function directoryBytes(root: string): number {
  try {
    return entryBytes(root);
  } catch {
    return 0;
  }
}

function entryBytes(path: string): number {
  const stat = lstatSync(path);
  if (!stat.isDirectory()) return stat.size;
  return readdirSync(path).reduce((total, name) => total + entryBytes(join(path, name)), 0);
}
