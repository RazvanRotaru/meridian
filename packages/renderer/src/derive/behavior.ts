/**
 * The /api/behavior payload (git-history churn + co-change) on the renderer side: a strict shape
 * guard over the UNTRUSTED fetched JSON, plus the pure joins from file paths onto composition
 * units. Any malformed payload parses to null so the UI degrades to "no behavior data" — it never
 * crashes. Paths are normalized to bare repo-relative POSIX on BOTH sides of every join, so a
 * leading "./" or a Windows separator in either source can never break the file⇄unit match.
 */

export interface CoChangePair {
  a: string;
  b: string;
  count: number;
  ratio: number;
}

/** The parsed behavior report. `churnByFile` is a Map so a file named `__proto__` stays inert. */
export interface BehaviorData {
  commitsAnalyzed: number;
  churnByFile: Map<string, number>;
  coChange: CoChangePair[];
}

/** The unit fields the joins need — structurally satisfied by `UnitMetrics`. */
export interface UnitFileRef {
  id: string;
  moduleFile: string;
}

/** Strict guard over the fetched JSON: the contract shape or null — never a partial result. */
export function parseBehavior(json: unknown): BehaviorData | null {
  if (!isRecord(json) || json.behaviorVersion !== "1" || !isCount(json.commitsAnalyzed)) {
    return null;
  }
  const churnByFile = churnMapOf(json.churnByFile);
  const coChange = coChangeListOf(json.coChange);
  if (churnByFile === null || coChange === null) {
    return null;
  }
  return { commitsAnalyzed: json.commitsAnalyzed, churnByFile, coChange };
}

/** Commits touching each unit's module file, keyed by unit id; units without churn are absent. */
export function churnByUnit(units: Iterable<UnitFileRef>, behavior: BehaviorData): Map<string, number> {
  const churn = new Map<string, number>();
  for (const unit of units) {
    const commits = behavior.churnByFile.get(normalizeRepoPath(unit.moduleFile));
    if (commits !== undefined) {
      churn.set(unit.id, commits);
    }
  }
  return churn;
}

/**
 * Co-change file pairs mapped onto DISTINCT unit-id pairs, ordered `[min, max]` by unit id and
 * deduplicated. A file hosts every unit declared in it (the module plus its classes), so one file
 * pair can fan out to several unit pairs; same-unit pairs cannot arise (two files, two modules).
 */
export function coChangeUnitPairs(units: Iterable<UnitFileRef>, behavior: BehaviorData): Array<[string, string]> {
  const unitsByFile = groupUnitsByFile(units);
  const seen = new Set<string>();
  const pairs: Array<[string, string]> = [];
  for (const { a, b } of behavior.coChange) {
    for (const unitA of unitsByFile.get(normalizeRepoPath(a)) ?? []) {
      for (const unitB of unitsByFile.get(normalizeRepoPath(b)) ?? []) {
        addDistinctPair(unitA, unitB, seen, pairs);
      }
    }
  }
  return pairs;
}

function groupUnitsByFile(units: Iterable<UnitFileRef>): Map<string, string[]> {
  const byFile = new Map<string, string[]>();
  for (const unit of units) {
    const file = normalizeRepoPath(unit.moduleFile);
    const bucket = byFile.get(file);
    bucket ? bucket.push(unit.id) : byFile.set(file, [unit.id]);
  }
  return byFile;
}

function addDistinctPair(unitA: string, unitB: string, seen: Set<string>, pairs: Array<[string, string]>): void {
  const [low, high] = unitA < unitB ? [unitA, unitB] : [unitB, unitA];
  const key = `${low}\n${high}`;
  if (low !== high && !seen.has(key)) {
    seen.add(key);
    pairs.push([low, high]);
  }
}

/** Bare repo-relative POSIX: backslashes become slashes, leading "./" segments are stripped. */
export function normalizeRepoPath(path: string): string {
  let normalized = path.replace(/\\/g, "/");
  while (normalized.startsWith("./")) {
    normalized = normalized.slice(2);
  }
  return normalized;
}

function churnMapOf(value: unknown): Map<string, number> | null {
  if (!isRecord(value)) {
    return null;
  }
  const churn = new Map<string, number>();
  for (const [file, commits] of Object.entries(value)) {
    if (!isCount(commits)) {
      return null;
    }
    churn.set(normalizeRepoPath(file), commits);
  }
  return churn;
}

function coChangeListOf(value: unknown): CoChangePair[] | null {
  if (!Array.isArray(value)) {
    return null;
  }
  const pairs: CoChangePair[] = [];
  for (const entry of value) {
    if (!isCoChangePair(entry)) {
      return null;
    }
    pairs.push({ ...entry, a: normalizeRepoPath(entry.a), b: normalizeRepoPath(entry.b) });
  }
  return pairs;
}

function isCoChangePair(entry: unknown): entry is CoChangePair {
  return (
    isRecord(entry) &&
    typeof entry.a === "string" &&
    typeof entry.b === "string" &&
    isCount(entry.count) &&
    typeof entry.ratio === "number" &&
    Number.isFinite(entry.ratio)
  );
}

function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
