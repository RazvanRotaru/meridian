import type { GitFixtureRevision, GitMonorepoFixture } from "./git-fixture";
import type { RevisionExtractionRequest } from "./model";

export const TEST_EXTRACTOR_VERSION = "typescript-extractor@0.1.0+package-shard-poc-v1";
export const TEST_POLICY_VERSION = "repository-analysis@8+typescript-shard-poc";

export function fixtureRequest(
  fixture: GitMonorepoFixture,
  revision: GitFixtureRevision,
  cacheDir = fixture.cacheDir,
  measureCacheBytes = false,
): RevisionExtractionRequest {
  return {
    root: fixture.root,
    treeOid: revision.treeOid,
    cacheDir,
    extractorVersion: TEST_EXTRACTOR_VERSION,
    analysisPolicyVersion: TEST_POLICY_VERSION,
    measureCacheBytes,
    options: {
      depth: "function",
      includeExternal: true,
      includeUnresolved: false,
      valueRefs: true,
    },
  };
}

export function replaceInFixture(
  fixture: GitMonorepoFixture,
  path: string,
  before: string,
  after: string,
): void {
  const current = fixture.readFile(path);
  if (!current.includes(before)) {
    throw new Error(`fixture edit anchor is missing from ${path}: ${before}`);
  }
  fixture.writeFile(path, current.replace(before, after));
}

export function shardKeys(manifest: { units: Array<{ shardKey: string }> }): Set<string> {
  return new Set(manifest.units.map((unit) => unit.shardKey));
}

export function intersectionSize(left: ReadonlySet<string>, right: ReadonlySet<string>): number {
  let count = 0;
  for (const value of left) {
    if (right.has(value)) count += 1;
  }
  return count;
}
