import type { ServerResponse } from "node:http";
import type { GraphArtifact } from "@meridian/core";
import { describe, expect, it, vi } from "vitest";
import { injectViewBoot } from "./web-boot";
import { sendView } from "./web-graph";
import type { Context } from "./web-server";
import type { ArtifactSource } from "./web-source";

describe("injectViewBoot", () => {
  it("advertises PR availability only for a GitHub-sourced graph", () => {
    const github = injectViewBoot("<head></head>", "graph-1", true);
    const local = injectViewBoot("<head></head>", "graph-2", false);

    expect(github).toContain('"githubSource":true');
    expect(local).toContain('"githubSource":false');
  });
});

describe("sendView", () => {
  it("derives PR availability from the stored artifact source", () => {
    expect(capturedView({ kind: "github", owner: "octo", repo: "repo" })).toContain('"githubSource":true');
    expect(capturedView({ kind: "other" })).toContain('"githubSource":false');
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
