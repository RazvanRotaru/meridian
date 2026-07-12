/**
 * Creating and serving the in-memory graphs behind the web flow. `/api/generate` clones + extracts
 * a source into an artifact kept under a deterministic id; `/api/graph|meta` and `/view` read it
 * back, and the extracted source dir is retained under the same id so `/api/source` can serve code
 * slices. The clone token is resolved by precedence — an explicit pasted token, else the signed-in
 * session's token, else the environment, else the local `gh` CLI login — so sign-in, manual tokens,
 * and an existing gh session all feed the vetted path.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import type { GraphArtifact } from "@meridian/core";
import { CliError } from "../errors";
import { extractToArtifact } from "../extract-pipeline";
import { resolveSource } from "./clone";
import { sendHtml, sendJson } from "./http-response";
import { injectViewBoot } from "./web-boot";
import { githubTokenFor } from "./web-auth";
import { artifactId, parseGenerateRequest, readJsonBody } from "./web-request";
import type { GenerateRequest } from "./web-request";
import { WebError } from "./web-error";
import type { Context } from "./web-server";
import { artifactSourceFor } from "./web-source";

export async function handleGenerate(ctx: Context, request: IncomingMessage, response: ServerResponse): Promise<void> {
  if (acceptsNdjson(request)) {
    await handleGenerateStream(ctx, request, response);
    return;
  }

  const parsed = parseGenerateRequest(await readJsonBody(request));
  const result = await generate(ctx, parsed, githubTokenFor(ctx, request, parsed.token));
  sendJson(response, 200, result);
}

interface GenerateResult {
  id: string;
  target: string;
  counts: { nodes: number; edges: number };
  warnings: string[];
}

type GenerateStage = "source" | "extract";

/**
 * The opt-in streaming form of `/api/generate`. Keeping it behind the NDJSON Accept header leaves
 * existing callers on the original one-shot JSON contract while the landing page can paint each
 * real server-side boundary as it happens.
 */
async function handleGenerateStream(ctx: Context, request: IncomingMessage, response: ServerResponse): Promise<void> {
  beginNdjson(response);
  try {
    const parsed = parseGenerateRequest(await readJsonBody(request));
    const result = await generate(ctx, parsed, githubTokenFor(ctx, request, parsed.token), (stage) =>
      writeLine(response, { stage }),
    );
    await writeLine(response, { stage: "done", ...result });
  } catch (error) {
    await writeLine(response, { stage: "error", message: safeGenerateMessage(error) });
  } finally {
    response.end();
  }
}

/** Resolve/clone, extract, and retain one source. `onStage` fires immediately before each job. */
async function generate(
  ctx: Context,
  parsed: GenerateRequest,
  token: string | undefined,
  onStage: (stage: GenerateStage) => void | Promise<void> = () => {},
): Promise<GenerateResult> {
  await onStage("source");
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
    await onStage("extract");
    const { artifact, warnings } = await extractToArtifact({
      absoluteRoot: source.dir,
      cwd: source.dir, // records target.root as "." — never leaks the temp clone path
      language: parsed.lang,
      depth: "function",
      includeExternal: true,
      materializeBoundary: true,
      // Opt-in via MERIDIAN_VALUE_REFS: emit `references` edges for imported symbols used as values,
      // so bare `imports` wires resolve into traceable dependencies (extra type-checker work).
      valueRefs: process.env.MERIDIAN_VALUE_REFS === "1",
      targetName: source.target, // the repo label (e.g. "sindresorhus/ky"), not the temp dir
    });
    const id = artifactId(parsed);
    ctx.graphs.set(id, artifact);
    ctx.sourceRoots.set(id, source.dir);
    ctx.sources.set(id, artifactSourceFor(parsed));
    ctx.tempCleanups.add(source.cleanup);
    retained = true;
    const counts = { nodes: artifact.nodes.length, edges: artifact.edges.length };
    return { id, target: source.target, counts, warnings };
  } finally {
    if (!retained) {
      source.cleanup();
    }
  }
}

function acceptsNdjson(request: IncomingMessage): boolean {
  const accept = request.headers.accept;
  const value = Array.isArray(accept) ? accept.join(",") : (accept ?? "");
  return value
    .split(",")
    .some((part: string) => part.trim().split(";", 1)[0]?.toLowerCase() === "application/x-ndjson");
}

function beginNdjson(response: ServerResponse): void {
  response.writeHead(200, { "content-type": "application/x-ndjson; charset=utf-8", "cache-control": "no-cache" });
}

/** Resolve once Node has handed the line off, yielding before CPU-heavy extraction begins. */
function writeLine(response: ServerResponse, line: Record<string, unknown>): Promise<void> {
  return new Promise((resolve, reject) => {
    response.write(`${JSON.stringify(line)}\n`, (error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

/** Expected request/CLI failures are already browser-safe; never expose an unknown error. */
function safeGenerateMessage(error: unknown): string {
  if (error instanceof WebError || error instanceof CliError) {
    return error.message;
  }
  return "internal error while generating the blueprint";
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
  const graphId = id as string;
  sendHtml(response, injectViewBoot(ctx.rendererIndex, graphId, ctx.sources.get(graphId)));
}

function lookup(ctx: Context, id: string | null): GraphArtifact | undefined {
  return id ? ctx.graphs.get(id) : undefined;
}
