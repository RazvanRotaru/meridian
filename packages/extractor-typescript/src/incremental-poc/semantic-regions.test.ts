import { describe, expect, it } from "vitest";
import {
  REQUIRED_SEMANTIC_REGION_EVIDENCE,
  planSemanticRegionInvalidation,
  planSemanticRegions,
  type SemanticDependency,
  type SemanticRegionPlan,
} from "./semantic-regions";

const COMPLETE_EVIDENCE = [...REQUIRED_SEMANTIC_REGION_EVIDENCE];

describe("semantic region planner", () => {
  it("forms deterministic SCC regions and evaluates providers before consumers", () => {
    const dependencies: SemanticDependency[] = [
      dependency("src/a.ts", "src/b.ts"),
      dependency("src/b.ts", "src/a.ts"),
      dependency("src/c.ts", "src/b.ts"),
    ];
    const forward = planSemanticRegions({
      files: ["src/d.ts", "src/c.ts", "src/b.ts", "src/a.ts"],
      dependencies,
      completeEvidence: COMPLETE_EVIDENCE,
    });
    const reversed = planSemanticRegions({
      files: ["src/a.ts", "src/b.ts", "src/c.ts", "src/d.ts"],
      dependencies: [...dependencies].reverse(),
      completeEvidence: [...COMPLETE_EVIDENCE].reverse(),
    });

    expect(forward).toEqual(reversed);
    expect(forward.kind).toBe("partitioned");
    expect(forward.regions.map((region) => region.files)).toEqual([
      ["src/a.ts", "src/b.ts"],
      ["src/c.ts"],
      ["src/d.ts"],
    ]);

    const cycle = regionWith(forward, "src/a.ts");
    const consumer = regionWith(forward, "src/c.ts");
    expect(consumer.dependencyRegionIds).toEqual([cycle.id]);
    expect(forward.evaluationOrder.indexOf(cycle.id))
      .toBeLessThan(forward.evaluationOrder.indexOf(consumer.id));
  });

  it("invalidates reverse consumers but reuses providers after a consumer-only edit", () => {
    const plan = planSemanticRegions({
      files: ["src/provider.ts", "src/consumer.ts", "src/entry.ts", "src/unrelated.ts"],
      dependencies: [
        dependency("src/consumer.ts", "src/provider.ts"),
        dependency("src/entry.ts", "src/consumer.ts"),
      ],
      completeEvidence: COMPLETE_EVIDENCE,
    });
    const provider = regionWith(plan, "src/provider.ts");
    const consumer = regionWith(plan, "src/consumer.ts");
    const entry = regionWith(plan, "src/entry.ts");
    const unrelated = regionWith(plan, "src/unrelated.ts");

    expect(planSemanticRegionInvalidation(plan, ["src/provider.ts"])).toEqual({
      rebuildRegionIds: inEvaluationOrder(plan, [provider.id, consumer.id, entry.id]),
      reusableRegionIds: [unrelated.id],
      reason: null,
    });
    expect(planSemanticRegionInvalidation(plan, ["src/consumer.ts"])).toEqual({
      rebuildRegionIds: inEvaluationOrder(plan, [consumer.id, entry.id]),
      reusableRegionIds: inEvaluationOrder(plan, [provider.id, unrelated.id]),
      reason: null,
    });
  });

  it("falls back to one whole-unit region when any proof obligation is incomplete", () => {
    const completeEvidence = COMPLETE_EVIDENCE.filter(
      (entry) => entry !== "extractor-cross-file-reads",
    );
    const plan = planSemanticRegions({
      files: ["src/a.ts", "src/b.ts"],
      dependencies: [],
      completeEvidence,
      unsafeReasons: ["unattributed-getType-read"],
    });

    expect(plan.kind).toBe("whole-unit-fallback");
    expect(plan.reasons).toEqual([
      "missing-evidence:extractor-cross-file-reads",
      "unsafe:unattributed-getType-read",
    ]);
    expect(plan.regions).toHaveLength(1);
    expect(plan.regions[0]?.files).toEqual(["src/a.ts", "src/b.ts"]);
  });

  it("invalidates the whole target plan for a deleted or otherwise unknown changed path", () => {
    const plan = planSemanticRegions({
      files: ["src/current.ts", "src/other.ts"],
      dependencies: [],
      completeEvidence: COMPLETE_EVIDENCE,
    });

    expect(planSemanticRegionInvalidation(plan, ["src/deleted.ts"])).toEqual({
      rebuildRegionIds: plan.evaluationOrder,
      reusableRegionIds: [],
      reason: "changed-file-outside-target-plan",
    });
  });

  it("rejects dependencies outside the exact selected source universe", () => {
    expect(() => planSemanticRegions({
      files: ["src/a.ts"],
      dependencies: [dependency("src/a.ts", "src/missing.ts")],
      completeEvidence: COMPLETE_EVIDENCE,
    })).toThrow("semantic dependency endpoint is outside the selected unit");
  });

  it("plans a 4,528-file dependency chain without recursive graph walking", () => {
    const files = Array.from(
      { length: 4_528 },
      (_, index) => `src/generated/file-${String(index).padStart(4, "0")}.ts`,
    );
    const dependencies = files.slice(1).map((consumer, index) =>
      dependency(consumer, files[index]!));

    const plan = planSemanticRegions({
      files,
      dependencies,
      completeEvidence: COMPLETE_EVIDENCE,
    });

    expect(plan.regions).toHaveLength(files.length);
    expect(plan.evaluationOrder).toHaveLength(files.length);
    expect(regionWith(plan, files.at(-1)!).dependencyRegionIds)
      .toEqual([regionWith(plan, files.at(-2)!).id]);
  });
});

function dependency(consumer: string, provider: string): SemanticDependency {
  return { consumer, provider, kind: "symbol-declaration" };
}

function regionWith(plan: SemanticRegionPlan, file: string) {
  const region = plan.regions.find((candidate) => candidate.files.includes(file));
  if (region === undefined) throw new Error(`test region missing ${file}`);
  return region;
}

function inEvaluationOrder(plan: SemanticRegionPlan, ids: readonly string[]): string[] {
  const selected = new Set(ids);
  return plan.evaluationOrder.filter((id) => selected.has(id));
}
