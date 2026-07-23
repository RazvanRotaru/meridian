import { describe, expect, it } from "vitest";
import {
  graphRetentionOptionsFromEnv,
  resolveGraphRetentionOptions,
  selectGraphRetentionCandidates,
  type GraphRetentionCandidate,
  type GraphRetentionOptions,
} from "./web-graph-retention";

const MIB = 1024 ** 2;
const GIB = 1024 ** 3;
const MINUTE_MS = 60_000;

describe("resolveGraphRetentionOptions", () => {
  it("provides bounded registry and view-lease defaults", () => {
    expect(resolveGraphRetentionOptions()).toEqual({
      maxEntries: 32,
      lowWaterEntries: 24,
      maxArtifactBytes: GIB,
      lowWaterArtifactBytes: 768 * MIB,
      maxSourceLeases: 12,
      lowWaterSourceLeases: 8,
      maxIdleMs: 120 * MINUTE_MS,
      publicationHandoffTtlMs: 5 * MINUTE_MS,
      sweepIntervalMs: MINUTE_MS,
      viewLeaseTtlMs: 5 * MINUTE_MS,
      maxViewLeases: 64,
      maxIdsPerView: 5,
    });
  });

  it("derives low watermarks from overridden highs with a strict lower bound", () => {
    expect(resolveGraphRetentionOptions({
      maxEntries: 8,
      maxArtifactBytes: 100,
      maxSourceLeases: 9,
    })).toMatchObject({
      lowWaterEntries: 6,
      lowWaterArtifactBytes: 75,
      lowWaterSourceLeases: 6,
    });
    expect(resolveGraphRetentionOptions({
      maxEntries: 1,
      maxArtifactBytes: 1,
      maxSourceLeases: 1,
    })).toMatchObject({
      lowWaterEntries: 0,
      lowWaterArtifactBytes: 0,
      lowWaterSourceLeases: 0,
    });
  });

  it.each([
    [{ maxEntries: 0 }, "maxEntries"],
    [{ maxEntries: 2, lowWaterEntries: 2 }, "lowWaterEntries"],
    [{ maxArtifactBytes: Number.MAX_SAFE_INTEGER + 1 }, "maxArtifactBytes"],
    [{ maxArtifactBytes: 2, lowWaterArtifactBytes: -1 }, "lowWaterArtifactBytes"],
    [{ maxSourceLeases: 2, lowWaterSourceLeases: 3 }, "lowWaterSourceLeases"],
    [{ maxIdleMs: Number.NaN }, "maxIdleMs"],
    [{ publicationHandoffTtlMs: -1 }, "publicationHandoffTtlMs"],
    [{ sweepIntervalMs: 1.5 }, "sweepIntervalMs"],
    [{ viewLeaseTtlMs: 0 }, "viewLeaseTtlMs"],
    [{ maxViewLeases: 0 }, "maxViewLeases"],
    [{ maxIdsPerView: 0 }, "maxIdsPerView"],
  ] as const)("rejects invalid override %j", (override, message) => {
    expect(() => resolveGraphRetentionOptions(override)).toThrow(message);
  });
});

describe("graphRetentionOptionsFromEnv", () => {
  it("returns only explicit overrides and derives each corresponding low watermark", () => {
    expect(graphRetentionOptionsFromEnv({})).toEqual({});
    expect(graphRetentionOptionsFromEnv({
      MERIDIAN_GRAPH_REGISTRY_MAX_MIB: "100.5",
      MERIDIAN_GRAPH_REGISTRY_MAX_ENTRIES: "20",
      MERIDIAN_GRAPH_REGISTRY_MAX_SOURCE_LEASES: "9",
      MERIDIAN_GRAPH_REGISTRY_MAX_IDLE_MINUTES: "30.5",
    })).toEqual({
      maxArtifactBytes: 100.5 * MIB,
      lowWaterArtifactBytes: Math.floor(100.5 * MIB * 0.75),
      maxEntries: 20,
      lowWaterEntries: 15,
      maxSourceLeases: 9,
      lowWaterSourceLeases: 6,
      maxIdleMs: 30.5 * MINUTE_MS,
    });
  });

  it.each([
    ["MERIDIAN_GRAPH_REGISTRY_MAX_MIB", ""],
    ["MERIDIAN_GRAPH_REGISTRY_MAX_MIB", "0"],
    ["MERIDIAN_GRAPH_REGISTRY_MAX_MIB", "1e3"],
    ["MERIDIAN_GRAPH_REGISTRY_MAX_ENTRIES", "1.5"],
    ["MERIDIAN_GRAPH_REGISTRY_MAX_ENTRIES", "9007199254740992"],
    ["MERIDIAN_GRAPH_REGISTRY_MAX_SOURCE_LEASES", "-1"],
    ["MERIDIAN_GRAPH_REGISTRY_MAX_IDLE_MINUTES", "Infinity"],
  ])("rejects invalid %s=%j", (name, value) => {
    expect(() => graphRetentionOptionsFromEnv({ [name]: value })).toThrow(name);
  });
});

describe("selectGraphRetentionCandidates", () => {
  const policy = (overrides: Partial<GraphRetentionOptions> = {}) => resolveGraphRetentionOptions({
    maxEntries: 10,
    lowWaterEntries: 8,
    maxArtifactBytes: 1_000,
    lowWaterArtifactBytes: 750,
    maxSourceLeases: 10,
    lowWaterSourceLeases: 6,
    maxIdleMs: 100,
    publicationHandoffTtlMs: 10,
    now: () => 1_000,
    ...overrides,
  });

  it("expires idle candidates first in last-access, publication, then id order", () => {
    const input = [
      candidate("z", 10, 800, 700),
      candidate("newer-publication", 10, 800, 750),
      candidate("a", 10, 800, 700),
      candidate("fresh", 10, 950, 700),
    ];
    const selected = selectGraphRetentionCandidates(input, policy());

    expect(selected.selected.map(({ candidate: item, reason }) => [item.id, reason])).toEqual([
      ["a", "max-idle"],
      ["z", "max-idle"],
      ["newer-publication", "max-idle"],
    ]);
    expect(selected.pressure).toEqual({
      entries: false,
      artifactBytes: false,
      sourceLeases: false,
    });
    expect(input.map(({ id }) => id)).toEqual(["z", "newer-publication", "a", "fresh"]);
  });

  it("never selects request/view pins or active publication handoffs", () => {
    const selected = selectGraphRetentionCandidates([
      candidate("pinned", 500, 100, 100, { pinned: true }),
      candidate("handoff", 500, 100, 995, { handoffUntilMs: 1_001 }),
      candidate("protected", 500, 100, 100, { handoffUntilMs: 1_001 }),
    ], policy({ maxEntries: 1, lowWaterEntries: 0 }));

    expect(selected.selected).toEqual([]);
    expect(selected.pressure.entries).toBe(true);
    expect(selected.projected.entries).toBe(3);
  });

  it("drains only dimensions that crossed high water to their low watermarks", () => {
    const selected = selectGraphRetentionCandidates([
      candidate("no-source-oldest", 0, 950, 100, { sourceLeases: 0 }),
      candidate("source-one", 10, 951, 100),
      candidate("source-two", 10, 952, 100),
      candidate("source-three", 10, 953, 100),
    ], policy({
      maxEntries: 10,
      lowWaterEntries: 8,
      maxArtifactBytes: 1_000,
      lowWaterArtifactBytes: 750,
      maxSourceLeases: 2,
      lowWaterSourceLeases: 1,
    }));

    expect(selected.pressure).toEqual({
      entries: false,
      artifactBytes: false,
      sourceLeases: true,
    });
    expect(selected.selected.map(({ candidate: item, reason }) => [item.id, reason])).toEqual([
      ["source-one", "capacity"],
      ["source-two", "capacity"],
    ]);
    expect(selected.projected).toEqual({ entries: 2, artifactBytes: 10, sourceLeases: 1 });
  });

  it("uses one deterministic LRU pass to satisfy simultaneous pressured dimensions", () => {
    const selected = selectGraphRetentionCandidates([
      candidate("oldest", 40, 950, 100),
      candidate("middle", 40, 960, 100),
      candidate("newest", 40, 970, 100),
    ], policy({
      maxEntries: 2,
      lowWaterEntries: 1,
      maxArtifactBytes: 100,
      lowWaterArtifactBytes: 60,
      maxSourceLeases: 10,
      lowWaterSourceLeases: 6,
    }));

    expect(selected.selected.map(({ candidate: item }) => item.id)).toEqual(["oldest", "middle"]);
    expect(selected.projected).toEqual({ entries: 1, artifactBytes: 40, sourceLeases: 1 });
  });

  it("includes non-evictable trash bytes in pressure and projected usage", () => {
    const selected = selectGraphRetentionCandidates([
      candidate("old", 40, 950, 100),
      candidate("new", 40, 960, 100),
    ], policy({
      maxArtifactBytes: 100,
      lowWaterArtifactBytes: 75,
    }), {
      entries: 0,
      artifactBytes: 50,
      sourceLeases: 0,
    });

    expect(selected.total.artifactBytes).toBe(130);
    expect(selected.selected.map(({ candidate: item }) => item.id)).toEqual(["old", "new"]);
    expect(selected.projected).toEqual({ entries: 0, artifactBytes: 50, sourceLeases: 0 });
  });

  it("rejects malformed candidates and unsafe aggregate accounting", () => {
    expect(() => selectGraphRetentionCandidates([
      candidate("same", 1, 1, 1),
      candidate("same", 1, 1, 1),
    ], policy())).toThrow("duplicate graph retention candidate id");
    expect(() => selectGraphRetentionCandidates([
      { ...candidate("bad-source", 1, 1, 1), sourceLeases: 2 as 0 | 1 },
    ], policy())).toThrow("sourceLeases");
    expect(() => selectGraphRetentionCandidates([
      candidate("one", Number.MAX_SAFE_INTEGER, 1, 1),
      candidate("two", 1, 1, 1),
    ], policy())).toThrow("artifact byte total");
    expect(() => selectGraphRetentionCandidates([], policy(), {
      entries: 0,
      artifactBytes: -1,
      sourceLeases: 0,
    })).toThrow("fixed graph retention usage artifactBytes");
  });
});

function candidate(
  id: string,
  artifactBytes: number,
  lastAccessAtMs: number,
  publishedAtMs: number,
  overrides: Partial<GraphRetentionCandidate> = {},
): GraphRetentionCandidate {
  return {
    id,
    artifactBytes,
    sourceLeases: 1,
    publishedAtMs,
    lastAccessAtMs,
    pinned: false,
    handoffUntilMs: 0,
    ...overrides,
  };
}
