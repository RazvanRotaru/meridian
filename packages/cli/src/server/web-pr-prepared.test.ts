import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { GraphArtifact } from "@meridian/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GRAPH_PROJECTION_DIRECTORY, writeGraphProjectionBundle } from "./graph-projection-bundle";
import { graphSummaryFor, InspectionSnapshotStore } from "./inspection-snapshot-store";
import { PreparedReviewHandoffStore } from "./prepared-review-handoff-store";
import { createWebServer } from "./web-server";

const HEAD_ID = "pr-head-restart-test";
const BASE_ID = "pr-base-restart-test";
const HEAD_SHA = "1".repeat(40);
const BASE_SHA = "a".repeat(40);
const MERGE_BASE_SHA = "c".repeat(40);

let root: string;
let server: Server | undefined;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "meridian-prepared-review-http-"));
});

afterEach(async () => {
  if (server) {
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = undefined;
  }
  rmSync(root, { recursive: true, force: true });
});

describe("prepared-review restart transport", () => {
  it("streams the exact v1 document and injects only a matching prepared boot URL", async () => {
    const cacheRoot = join(root, "cache");
    const rendererRoot = join(root, "renderer");
    const webUiPath = join(root, "landing.html");
    mkdirSync(rendererRoot, { recursive: true });
    writeFileSync(join(rendererRoot, "index.html"), "<!doctype html><html><head></head><body>renderer</body></html>");
    writeFileSync(webUiPath, "<!doctype html><html><head></head><body>landing</body></html>");

    const head = publishGraph(cacheRoot, HEAD_ID, HEAD_SHA);
    const mergeBase = publishGraph(cacheRoot, BASE_ID, MERGE_BASE_SHA);
    const originalStore = new PreparedReviewHandoffStore({ cacheRoot });
    const candidate = originalStore.prepare({
      request: {
        owner: "org", repo: "repo", subdir: "packages/app", prNumber: 41,
        baseRef: "main", headRef: "feature/review",
      },
      headSha: HEAD_SHA,
      baseSha: BASE_SHA,
      mergeBaseSha: MERGE_BASE_SHA,
      changedFiles: [
        { path: "src/added.ts", status: "added" },
        { path: "src/deleted.ts", status: "deleted" },
        { path: "src/modified.ts", status: "modified" },
        { path: "src/new.ts", previousPath: "src/old.ts", status: "renamed" },
      ],
      head,
      mergeBase,
      cache: "miss",
      timings: { resolve: 1, git: 2, "extract-head": 3, "extract-merge-base": 4, publish: 5 },
      warnings: [],
    });
    const reference = originalStore.publish(candidate);

    // A new server constructs fresh lazy stores and recovers only from cache-root files.
    server = createWebServer({ rendererRoot, webUiPath, cwd: root, cacheRoot });
    const base = await listenEphemeral(server);
    const prepared = await fetch(`${base}${reference.url}`);
    expect(prepared.status).toBe(200);
    expect(prepared.headers.get("cache-control")).toContain("immutable");
    expect(prepared.headers.get("etag")).toBe(`"${candidate.contentSha256}"`);
    expect(await prepared.json()).toEqual(candidate.document);
    for (const method of ["POST", "PUT", "PATCH", "DELETE", "OPTIONS"]) {
      const wrongMethod = await fetch(`${base}${reference.url}`, {
        method,
        ...(method === "POST" ? {
          headers: { "content-type": "application/json" },
          body: "{}",
        } : {}),
      });
      expect(wrongMethod.status).toBe(405);
      expect(wrongMethod.headers.get("allow")).toBe("GET");
    }
    const getOnly = await fetch(`${base}/api/pr/prepare`);
    expect(getOnly.status).toBe(405);
    expect(getOnly.headers.get("allow")).toBe("POST");
    expect((await fetch(`${base}/api/not-real`, { method: "PUT" })).status).toBe(404);

    const view = await fetch(`${base}${reference.viewUrl}`);
    expect(view.status).toBe(200);
    expect(await view.text()).toContain(`"preparedReviewUrl":"${reference.url}"`);

    const ordinary = await fetch(`${base}/view?id=${HEAD_ID}`);
    expect(ordinary.status).toBe(200);
    expect(await ordinary.text()).toContain('"preparedReviewUrl":null');

    expect((await fetch(`${base}/view?id=${BASE_ID}&view=modules&prn=41&rev=1&prepared=${reference.id}`)).status)
      .toBe(404);
    expect((await fetch(`${base}/view?id=${HEAD_ID}&view=modules&prn=42&rev=1&prepared=${reference.id}`)).status)
      .toBe(404);
    expect((await fetch(`${base}/view?id=${HEAD_ID}&view=modules&prn=41&rev=2&prepared=${reference.id}`)).status)
      .toBe(404);
    expect((await fetch(`${base}/view?id=${HEAD_ID}&view=flows&prn=41&rev=1&prepared=${reference.id}`)).status)
      .toBe(404);
    expect((await fetch(`${base}/api/pr/prepared?id=../../outside`)).status).toBe(404);
  });
});

function publishGraph(cacheRoot: string, id: string, commit: string) {
  const graphRoot = join(cacheRoot, "test-graphs", id);
  const sourceRoot = join(cacheRoot, "test-sources", id);
  const artifactPath = join(graphRoot, "artifact.json");
  mkdirSync(graphRoot, { recursive: true });
  mkdirSync(join(sourceRoot, "packages", "app"), { recursive: true });
  writeFileSync(join(sourceRoot, "packages", "app", "index.ts"), "export const value = 1;\n");
  const artifact: GraphArtifact = {
    schemaVersion: "1.1.0",
    generatedAt: "2026-07-16T00:00:00.000Z",
    generator: { name: "test", version: "1" },
    target: {
      name: "org/repo",
      root: ".",
      language: "typescript",
      vcs: { repository: "https://github.com/org/repo.git", commit },
    },
    nodes: [],
    edges: [],
  };
  writeFileSync(artifactPath, JSON.stringify(artifact));
  writeGraphProjectionBundle(join(graphRoot, GRAPH_PROJECTION_DIRECTORY), artifact);
  new InspectionSnapshotStore({ cacheRoot }).publish({
    id,
    artifactPath,
    graphSummary: graphSummaryFor(artifact),
    sourceRoot,
    sourceSubdir: "packages/app",
    source: { kind: "github", owner: "org", repo: "repo", subdir: "packages/app" },
  });
  const encoded = encodeURIComponent(id);
  return {
    graphId: id,
    manifestUrl: `/api/graph/manifest?id=${encoded}`,
    projectionUrl: `/api/graph/projection?id=${encoded}`,
    sourceUrl: `/api/source?id=${encoded}`,
    metaUrl: `/api/meta?id=${encoded}`,
    graphSummary: graphSummaryFor(artifact),
  };
}

async function listenEphemeral(active: Server): Promise<string> {
  await new Promise<void>((resolve, reject) => {
    active.once("error", reject);
    active.listen(0, "127.0.0.1", () => {
      active.off("error", reject);
      resolve();
    });
  });
  const address = active.address() as AddressInfo;
  return `http://127.0.0.1:${address.port}`;
}
