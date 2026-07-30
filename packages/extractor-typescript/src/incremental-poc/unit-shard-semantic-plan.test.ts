import {
  chmodSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { canonicalJson, canonicalJsonSha256 } from "./canonical-json";
import { createGitMonorepoFixture, type GitMonorepoFixture } from "./git-fixture";
import { immutableJsonCachePath } from "./immutable-cache";
import { fixtureRequest } from "./test-support";

const addressSemanticRegionsCall = vi.hoisted(() => vi.fn());

vi.mock("./semantic-region-inputs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./semantic-region-inputs")>();
  return {
    ...actual,
    addressSemanticRegions: (
      inputs: Parameters<typeof actual.addressSemanticRegions>[0],
    ) => {
      addressSemanticRegionsCall();
      return actual.addressSemanticRegions(inputs);
    },
  };
});

import { extractRevisionWithCache } from "./extract-revision";

describe("immutable unit shard semantic-plan reuse", { timeout: 30_000 }, () => {
  let fixture: GitMonorepoFixture;

  beforeEach(() => {
    fixture = createGitMonorepoFixture();
    addressSemanticRegionsCall.mockClear();
  });

  afterEach(() => {
    fixture.cleanup();
  });

  it("does not address semantic regions on full-unit hits and preserves cold manifest parity", async () => {
    const request = fixtureRequest(fixture, fixture.seedRevision);
    const initial = await extractRevisionWithCache(request);
    expect(addressSemanticRegionsCall).toHaveBeenCalledTimes(initial.metrics.totalUnits);

    addressSemanticRegionsCall.mockClear();
    const warm = await extractRevisionWithCache(request);
    expect(warm.metrics.reusedUnits).toBe(warm.metrics.totalUnits);
    expect(addressSemanticRegionsCall).not.toHaveBeenCalled();
    expect(warm.manifest).toEqual(initial.manifest);

    addressSemanticRegionsCall.mockClear();
    const cold = await extractRevisionWithCache({
      ...request,
      cacheDir: join(fixture.cacheDir, "..", "semantic-plan-cold-cache"),
    });
    expect(cold.metrics.rebuiltUnits).toBe(cold.metrics.totalUnits);
    expect(addressSemanticRegionsCall).toHaveBeenCalledTimes(cold.metrics.totalUnits);
    expect(warm.manifest).toEqual(cold.manifest);
    expect(warm.result).toEqual(cold.result);
  });

  it("rejects a stored semantic plan with a non-schema field", async () => {
    const request = fixtureRequest(fixture, fixture.seedRevision);
    const initial = await extractRevisionWithCache(request);
    const unit = initial.manifest.units[0]!;
    const shardPath = immutableJsonCachePath(
      join(fixture.cacheDir, "shards"),
      unit.shardKey,
    );
    const envelope = JSON.parse(readFileSync(shardPath, "utf8")) as {
      payloadDigest: string;
      value: {
        semanticPlan: Record<string, unknown>;
      };
    };
    envelope.value.semanticPlan.legacyPlanVersion = 1;
    envelope.payloadDigest = canonicalJsonSha256(envelope.value);
    chmodSync(shardPath, 0o600);
    writeFileSync(shardPath, canonicalJson(envelope));
    chmodSync(shardPath, 0o400);

    await expect(extractRevisionWithCache(request)).rejects.toThrow(
      /immutable unit shard identity mismatch/,
    );
  });
});
