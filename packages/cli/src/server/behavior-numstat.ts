/**
 * Pure parsing/aggregation for the `--behavior` git-history pass — no process, no IO.
 *
 * Input is `git log --numstat --format=%H` output; output is the /api/behavior payload core:
 * per-file churn plus co-change pairs. Numstat paths are repo-top-relative, so each one is
 * re-rooted onto the served source root and normalized to POSIX; anything that resolves
 * outside the source-root subtree is dropped, so the endpoint can never name a file from
 * elsewhere on the machine.
 */

import { isAbsolute, relative, resolve, sep } from "node:path";

export interface CoChangePair {
  a: string;
  b: string;
  count: number;
  ratio: number;
}

export interface BehaviorStats {
  commitsAnalyzed: number;
  churnByFile: Record<string, number>;
  coChange: CoChangePair[];
}

const COMMIT_HASH_LINE = /^[0-9a-f]{40}$/;
/** `<added>\t<deleted>\t<path>`; binary files report `-\t-\t<path>` and still count as touches. */
const NUMSTAT_LINE = /^(?:\d+|-)\t(?:\d+|-)\t(.+)$/;

const MIN_PAIR_COUNT = 3;
const MIN_PAIR_RATIO = 0.5;
const MAX_PAIRS = 200;
/** Commits touching more files than this (bulk moves, format sweeps) skew co-change; they still count as churn. */
const MAX_FILES_PER_COMMIT_FOR_PAIRS = 50;

export function aggregateNumstatLog(log: string, repoRoot: string, sourceRoot: string): BehaviorStats {
  const { commitsAnalyzed, touchedPerCommit } = parseCommits(log, repoRoot, sourceRoot);
  const churn = countChurn(touchedPerCommit);
  return {
    commitsAnalyzed,
    churnByFile: Object.fromEntries(churn),
    coChange: countCoChange(touchedPerCommit, churn),
  };
}

function parseCommits(
  log: string,
  repoRoot: string,
  sourceRoot: string,
): { commitsAnalyzed: number; touchedPerCommit: string[][] } {
  const touchedPerCommit: string[][] = [];
  let commitsAnalyzed = 0;
  let current: Set<string> | null = null;
  for (const line of log.split("\n")) {
    if (COMMIT_HASH_LINE.test(line)) {
      pushCommit(touchedPerCommit, current);
      current = new Set();
      commitsAnalyzed += 1;
      continue;
    }
    const file = touchedFileOf(line, repoRoot, sourceRoot);
    if (file && current) {
      current.add(file);
    }
  }
  pushCommit(touchedPerCommit, current);
  return { commitsAnalyzed, touchedPerCommit };
}

/** Sorted so every later pair enumeration yields `a < b` lexicographically for free. */
function pushCommit(touchedPerCommit: string[][], files: Set<string> | null): void {
  if (files && files.size > 0) {
    touchedPerCommit.push([...files].sort());
  }
}

function touchedFileOf(line: string, repoRoot: string, sourceRoot: string): string | null {
  const match = NUMSTAT_LINE.exec(line);
  return match ? rerootPath(match[1], repoRoot, sourceRoot) : null;
}

/** Repo-top-relative git path → source-root-relative POSIX path, or null when it escapes the root. */
function rerootPath(gitPath: string, repoRoot: string, sourceRoot: string): string | null {
  const rerooted = relative(resolve(sourceRoot), resolve(repoRoot, gitPath));
  if (rerooted === "" || rerooted.startsWith("..") || isAbsolute(rerooted)) {
    return null;
  }
  return rerooted.split(sep).join("/");
}

/** Maps (not plain objects) throughout, so a file named `__proto__` stays inert data. */
function countChurn(touchedPerCommit: string[][]): Map<string, number> {
  const churn = new Map<string, number>();
  for (const files of touchedPerCommit) {
    for (const file of files) {
      churn.set(file, (churn.get(file) ?? 0) + 1);
    }
  }
  return churn;
}

function countCoChange(touchedPerCommit: string[][], churn: Map<string, number>): CoChangePair[] {
  const pairCounts = new Map<string, number>();
  for (const files of touchedPerCommit) {
    countCommitPairs(files, pairCounts);
  }
  return topPairs(pairCounts, churn);
}

function countCommitPairs(files: string[], pairCounts: Map<string, number>): void {
  if (files.length > MAX_FILES_PER_COMMIT_FOR_PAIRS) {
    return;
  }
  for (let first = 0; first < files.length; first += 1) {
    for (let second = first + 1; second < files.length; second += 1) {
      const key = `${files[first]}\n${files[second]}`;
      pairCounts.set(key, (pairCounts.get(key) ?? 0) + 1);
    }
  }
}

function topPairs(pairCounts: Map<string, number>, churn: Map<string, number>): CoChangePair[] {
  const pairs: CoChangePair[] = [];
  for (const [key, count] of pairCounts) {
    const pair = qualifyingPair(key, count, churn);
    if (pair) {
      pairs.push(pair);
    }
  }
  pairs.sort(byCountThenName);
  return pairs.slice(0, MAX_PAIRS);
}

/** ratio = coCount / min(churn(a), churn(b)); gate on the exact value, report it rounded. */
function qualifyingPair(key: string, count: number, churn: Map<string, number>): CoChangePair | null {
  if (count < MIN_PAIR_COUNT) {
    return null;
  }
  const [a, b] = key.split("\n") as [string, string];
  const ratio = count / Math.min(churn.get(a) ?? count, churn.get(b) ?? count);
  return ratio >= MIN_PAIR_RATIO ? { a, b, count, ratio: round2(ratio) } : null;
}

function byCountThenName(left: CoChangePair, right: CoChangePair): number {
  return right.count - left.count || left.a.localeCompare(right.a) || left.b.localeCompare(right.b);
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}
