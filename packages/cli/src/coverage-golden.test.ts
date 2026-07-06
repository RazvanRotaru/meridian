/**
 * Golden: the full test-visibility + coverage story over the real orders-service fixture.
 * The pipeline must tag `src/__tests__/*` nodes, coverage must tell direct hits from
 * transitive reach from genuine gaps (with reasons), and `--exclude-tests` must restore a
 * production-only graph.
 */

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { TEST_TAG, computeCoverage } from "@meridian/core";
import type { GraphArtifact } from "@meridian/core";
import { extractToArtifact } from "./extract-pipeline";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const FIXTURE = join(REPO, "examples", "orders-service");

async function extractFixture(excludeTests = false): Promise<GraphArtifact> {
  const result = await extractToArtifact({
    absoluteRoot: FIXTURE,
    cwd: REPO,
    project: join(FIXTURE, "tsconfig.json"),
    materializeBoundary: false,
    excludeTests,
  });
  return result.artifact;
}

function idOf(artifact: GraphArtifact, qualifiedName: string): string {
  const node = artifact.nodes.find((candidate) => candidate.qualifiedName === qualifiedName);
  if (!node) {
    throw new Error(`fixture drift: no node with qualifiedName ${qualifiedName}`);
  }
  return node.id;
}

describe("test tagging over orders-service", () => {
  it("tags every node from src/__tests__ with 'test' and nothing else", async () => {
    const artifact = await extractFixture();
    const testNodes = artifact.nodes.filter((node) => node.tags?.includes(TEST_TAG));
    expect(testNodes.length).toBeGreaterThan(0);
    expect(testNodes.every((node) => node.location.file.includes("__tests__"))).toBe(true);
    const prodFiles = artifact.nodes.filter(
      (node) => !node.location.file.includes("__tests__") && node.tags?.includes(TEST_TAG),
    );
    expect(prodFiles).toEqual([]);
  });

  it("--exclude-tests drops test nodes and every edge touching them", async () => {
    const lean = await extractFixture(true);
    expect(lean.nodes.some((node) => node.tags?.includes(TEST_TAG))).toBe(false);
    const ids = new Set(lean.nodes.map((node) => node.id));
    const dangling = lean.edges.filter((edge) => !ids.has(edge.source));
    expect(dangling).toEqual([]);
  });
});

describe("static coverage over orders-service", () => {
  it("labels direct, transitive, and uncovered callables with reasons", async () => {
    const artifact = await extractFixture();
    const report = computeCoverage(artifact.nodes, artifact.edges);

    // placeOrder is called straight from the test file; its fan-out is reached transitively.
    expect(report.leaves[idOf(artifact, "OrderService.placeOrder")].status).toBe("covered");
    expect(report.leaves[idOf(artifact, "OrderRepository.save")].status).toBe("indirect");
    expect(report.leaves[idOf(artifact, "EmailService.sendOrderConfirmation")].status).toBe("indirect");
    // price is BOTH transitively reached and directly tested — direct wins.
    expect(report.leaves[idOf(artifact, "PricingService.price")].status).toBe("covered");

    // The API layer has no tests: handleCreateOrder is an untested entry point...
    const handler = report.leaves[idOf(artifact, "OrderRoutes.handleCreateOrder")];
    expect(handler.status).toBe("uncovered");
    expect(handler.reason?.kind).toBe("never-called");
    // ...and its private helper is uncovered BECAUSE its only caller is.
    const created = report.leaves[idOf(artifact, "OrderRoutes.created")];
    expect(created.status).toBe("uncovered");
    expect(created.reason?.kind).toBe("only-uncovered-callers");
    expect(created.reason?.callers).toContain(idOf(artifact, "OrderRoutes.handleCreateOrder"));
  });

  it("rolls classes up: OrderRoutes 0%, OrderService partial, summary in between", async () => {
    const artifact = await extractFixture();
    const report = computeCoverage(artifact.nodes, artifact.edges);
    expect(report.containers[idOf(artifact, "OrderRoutes")].status).toBe("uncovered");
    expect(report.containers[idOf(artifact, "PricingService")].status).toBe("covered");
    expect(report.summary.percent).toBeGreaterThan(0);
    expect(report.summary.percent).toBeLessThan(100);
    expect(report.summary.testNodes).toBeGreaterThan(0);
  });
});
