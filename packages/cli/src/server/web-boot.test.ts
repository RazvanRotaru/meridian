import type { ServerResponse } from "node:http";
import type { GraphArtifact } from "@meridian/core";
import { describe, expect, it, vi } from "vitest";
import { injectViewBoot } from "./web-boot";
import { sendView } from "./web-graph";
import type { Context } from "./web-server";
import type { ArtifactSource } from "./web-source";

describe("injectViewBoot", () => {
  it("exposes the exact PR-session source only for a GitHub-sourced graph", () => {
    const github = injectViewBoot("<head></head>", "graph-1", { kind: "github", owner: "octo", repo: "repo" });
    const local = injectViewBoot("<head></head>", "graph-2", { kind: "other" });

    expect(github).toContain('"traceUrl":"/api/traces"');
    expect(local).toContain('"traceUrl":"/api/traces"');
    expect(github).toContain('"telemetrySources":[]');
    expect(github).toContain('"preselectedTelemetrySourceId":null');
    expect(github).toContain('"githubSource":{"repository":"octo/repo","subdir":""}');
    expect(local).toContain('"githubSource":null');
  });
});

describe("sendView", () => {
  it("derives the exact PR-session source from the stored artifact source", () => {
    expect(capturedView({ kind: "github", owner: "octo", repo: "repo" })).toContain(
      '"githubSource":{"repository":"octo/repo","subdir":""}',
    );
    expect(capturedView({ kind: "other" })).toContain('"githubSource":null');
  });
});

function capturedView(source: ArtifactSource): string {
  const id = "graph-1";
  const ctx = {
    graphs: new Map([[id, {} as GraphArtifact]]),
    sources: new Map([[id, source]]),
    rendererIndex: "<head></head>",
  } as unknown as Context;
  let html = "";
  const response = {
    writeHead: vi.fn(),
    end: vi.fn((body: string) => {
      html = body;
    }),
  } as unknown as ServerResponse;

  sendView(ctx, response, id);
  return html;
}
