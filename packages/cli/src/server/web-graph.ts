/**
 * Creating and serving the in-memory graphs behind the web flow. `/api/generate` clones + extracts
 * a source into an artifact kept under a deterministic id; `/api/graph|meta` and `/view` read it
 * back, and the extracted source dir is retained under the same id so `/api/source` can serve code
 * slices. The clone token is resolved by precedence — an explicit pasted token, else the signed-in
 * session's token, else the environment — so sign-in and manual tokens both feed the vetted path.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import type { GraphArtifact } from "@meridian/core";
import { extractToArtifact } from "../extract-pipeline";
import { resolveSource } from "./clone";
import { sendHtml, sendJson } from "./http-response";
import { injectViewBoot } from "./web-boot";
import { sessionTokenFor } from "./web-auth";
import { artifactId, parseGenerateRequest, readJsonBody } from "./web-request";
import type { Context } from "./web-server";

export async function handleGenerate(ctx: Context, request: IncomingMessage, response: ServerResponse): Promise<void> {
  const parsed = parseGenerateRequest(await readJsonBody(request));
  const token = parsed.token ?? sessionTokenFor(ctx, request) ?? process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;
  const source = await resolveSource(
    { kind: parsed.kind, value: parsed.value, ref: parsed.ref, subdir: parsed.subdir },
    ctx.cwd,
    token,
  );
  // A successful generate retains the source (so `/api/source` can read it) and defers cleanup to
  // process exit; only a failure removes the temp clone now. A local path's cleanup is a no-op, so
  // this never deletes the user's own directory.
  let retained = false;
  try {
    const { artifact, warnings } = await extractToArtifact({
      absoluteRoot: source.dir,
      cwd: source.dir, // records target.root as "." — never leaks the temp clone path
      language: parsed.lang,
      depth: "function",
      materializeBoundary: false,
      targetName: source.target, // the repo label (e.g. "sindresorhus/ky"), not the temp dir
    });
    const id = artifactId(parsed);
    ctx.graphs.set(id, artifact);
    ctx.sourceRoots.set(id, source.dir);
    ctx.tempCleanups.add(source.cleanup);
    retained = true;
    const counts = { nodes: artifact.nodes.length, edges: artifact.edges.length };
    sendJson(response, 200, { id, target: source.target, counts, warnings });
  } finally {
    if (!retained) {
      source.cleanup();
    }
  }
}

export function sendGraph(ctx: Context, response: ServerResponse, id: string | null): void {
  const artifact = lookup(ctx, id);
  if (!artifact) {
    sendJson(response, 404, { error: "unknown graph id" });
    return;
  }
  sendJson(response, 200, artifact);
}

export function sendMeta(ctx: Context, response: ServerResponse, id: string | null): void {
  const artifact = lookup(ctx, id);
  if (!artifact) {
    sendJson(response, 404, { error: "unknown graph id" });
    return;
  }
  sendJson(response, 200, {
    schemaVersion: artifact.schemaVersion,
    generatedAt: artifact.generatedAt,
    nodeCount: artifact.nodes.length,
    hasOverlay: false,
    environments: [],
  });
}

export function sendView(ctx: Context, response: ServerResponse, id: string | null): void {
  if (!lookup(ctx, id)) {
    sendHtml(response, "<!doctype html><meta charset=utf-8><title>Meridian</title><p>Unknown graph id.</p>", 404);
    return;
  }
  sendHtml(response, injectViewBoot(ctx.rendererIndex, id as string));
}

function lookup(ctx: Context, id: string | null): GraphArtifact | undefined {
  return id ? ctx.graphs.get(id) : undefined;
}
