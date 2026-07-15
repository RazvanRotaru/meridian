/** Strict, versioned NDJSON transport for two-sided pull-request preparation. */

import { createHash } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { CliError } from "../errors";
import { githubTokenFor } from "./web-auth";
import { WebError } from "./web-error";
import { readJsonBody } from "./web-request";
import { parsePrPrepareRequest, sourceForPrPrepare } from "./web-pr-request";
import type { PrPrepareRequest } from "./web-pr-request";
import type { Context } from "./web-server";
import { InspectionQueueFullError } from "./inspection-scheduler";
import type { CachedPrPreparation, CachedPrSide, PrPrepareProgress } from "./web-pr-cache";
import type { InspectionGraphSummary } from "./inspection-snapshot-store";
import {
  readSyntheticCapabilitySidecar,
  syntheticCapabilitySidecarPath,
} from "./synthetic-capability-sidecar";

const PROTOCOL_VERSION = 1;
const MAX_NDJSON_LINE_BYTES = 2 * 1024 * 1024;

export interface PreparedGraphDescriptor {
  graphId: string;
  manifestUrl: string;
  projectionUrl: string;
  sourceUrl: string;
  metaUrl: string;
  graphSummary: InspectionGraphSummary;
}

export async function handlePrPrepare(
  ctx: Context,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  const body = parsePrPrepareRequest(await readJsonBody(request));
  const token = githubTokenFor(ctx, request);
  const cancellation = cancelWhenClientLeaves(request, response);
  try {
    let pending: Promise<CachedPrPreparation>;
    try {
      pending = ctx.prInspectionScheduler.schedule(
        prJobKey(body, token, ctx.refreshCache),
        {
          cacheRoot: ctx.cacheRoot,
          request: body,
          cwd: ctx.cwd,
          ...(token ? { token } : {}),
          refresh: ctx.refreshCache,
          repositoryMirrors: ctx.repositoryMirrors,
          runExtraction: ctx.runExtraction,
        },
        {
          signal: cancellation.signal,
          onProgress: (progress) => writeProgress(response, progress),
        },
      );
    } catch (error) {
      throwQueueFull(response, error);
    }
    // Admission is synchronous, so overload remains an HTTP 429 before this 200 stream starts.
    beginNdjson(response);
    try {
      const prepared = await pending;
      const descriptors = publishDescriptors(ctx, body, prepared);
      writeLine(response, {
        version: PROTOCOL_VERSION,
        type: "done",
        headSha: prepared.headSha,
        baseSha: prepared.baseSha,
        mergeBaseSha: prepared.mergeBaseSha,
        changedFiles: prepared.changedFiles,
        head: descriptors.head,
        mergeBase: descriptors.mergeBase,
        cache: prepared.cache,
        timings: prepared.timings,
        warnings: prepared.warnings,
      });
    } catch (error) {
      if (!cancellation.signal.aborted) {
        writeLine(response, { version: PROTOCOL_VERSION, type: "error", message: safeMessage(error) });
      }
    } finally {
      response.end();
    }
  } finally {
    cancellation.dispose();
  }
}

function publishDescriptors(
  ctx: Context,
  request: PrPrepareRequest,
  prepared: CachedPrPreparation,
): { head: PreparedGraphDescriptor; mergeBase: PreparedGraphDescriptor } {
  const source = sourceForPrPrepare(request);
  const headId = graphId("head", [
    prepared.repositoryKey,
    prepared.securityDigest,
    request.subdir ?? "",
    request.headRef,
    prepared.headSha,
    prepared.mergeBaseSha,
    prepared.analysisKey,
    prepared.generationId,
  ], prepared.headSha);
  const mergeBaseId = graphId("base", [
    prepared.repositoryKey,
    prepared.securityDigest,
    request.subdir ?? "",
    prepared.mergeBaseSha,
    prepared.analysisKey,
    prepared.mergeBaseGenerationId,
  ], prepared.mergeBaseSha);
  publishSide(ctx, headId, prepared.head, source, request.subdir, request.headRef, prepared.headSha);
  publishSide(ctx, mergeBaseId, prepared.mergeBase, source, request.subdir);
  return {
    head: descriptorFor(headId, prepared.head.graphSummary),
    mergeBase: descriptorFor(mergeBaseId, prepared.mergeBase.graphSummary),
  };
}

function publishSide(
  ctx: Context,
  graphId: string,
  side: CachedPrSide,
  source: ReturnType<typeof sourceForPrPrepare>,
  subdir: string | undefined,
  branch?: string,
  preparedHeadSha?: string,
): void {
  const synthetic = readSyntheticCapabilitySidecar(syntheticCapabilitySidecarPath(side.artifactPath));
  const canExecute = preparedHeadSha !== undefined
    && synthetic?.state === "ready"
    && synthetic.scenarios.length > 0
    && synthetic.sourceFingerprint !== null;
  ctx.inspectionSnapshots.publish({
    id: graphId,
    artifactPath: side.artifactPath,
    graphSummary: side.graphSummary,
    ...(branch ? { vcsBranch: branch } : {}),
    sourceRoot: side.sourceRoot,
    ...(subdir ? { sourceSubdir: subdir } : {}),
    source,
    ...(canExecute ? {
      syntheticExecutionTrust: {
        mode: "sandboxed-pr" as const,
        provenance: {
          repository: `${source.owner}/${source.repo}`,
          headSha: preparedHeadSha,
        },
      },
    } : {}),
  });
}

function descriptorFor(graphId: string, graphSummary: InspectionGraphSummary): PreparedGraphDescriptor {
  const id = encodeURIComponent(graphId);
  return {
    graphId,
    manifestUrl: `/api/graph/manifest?id=${id}`,
    projectionUrl: `/api/graph/projection?id=${id}`,
    sourceUrl: `/api/source?id=${id}`,
    metaUrl: `/api/meta?id=${id}`,
    graphSummary,
  };
}

function graphId(side: "head" | "base", parts: readonly string[], commit: string): string {
  const digest = createHash("sha256").update(JSON.stringify([side, ...parts])).digest("hex").slice(0, 24);
  return `pr-${side}-${digest}-${commit.slice(0, 16)}`;
}

function prJobKey(request: PrPrepareRequest, token: string | undefined, refresh: boolean): string {
  const credential = token ? createHash("sha256").update(token).digest("hex") : "anonymous";
  const { headRef: _headRef, ...preparationIdentity } = request;
  return createHash("sha256")
    .update(JSON.stringify({ request: preparationIdentity, credential, refresh }))
    .digest("hex");
}

function writeProgress(response: ServerResponse, progress: PrPrepareProgress): void {
  writeLine(response, {
    version: PROTOCOL_VERSION,
    type: "progress",
    stage: progress.stage,
    elapsedMs: progress.elapsedMs,
  });
}

function beginNdjson(response: ServerResponse): void {
  response.writeHead(200, {
    "content-type": "application/x-ndjson; charset=utf-8",
    "cache-control": "no-store",
  });
}

function writeLine(response: ServerResponse, line: Record<string, unknown>): void {
  const serialized = JSON.stringify(line);
  if (Buffer.byteLength(serialized, "utf8") > MAX_NDJSON_LINE_BYTES) {
    throw new WebError(422, "PR preparation result exceeds the 2 MiB NDJSON line limit");
  }
  response.write(`${serialized}\n`);
}

function throwQueueFull(response: ServerResponse, error: unknown): never {
  if (error instanceof InspectionQueueFullError) {
    response.setHeader?.("retry-after", "5");
    throw new WebError(error.status, error.message);
  }
  throw error;
}

function safeMessage(error: unknown): string {
  if (error instanceof WebError || error instanceof CliError) return error.message;
  return "internal error while preparing the pull request";
}

function cancelWhenClientLeaves(
  request: IncomingMessage,
  response: ServerResponse,
): { signal: AbortSignal; dispose(): void } {
  const controller = new AbortController();
  const abort = () => {
    if (controller.signal.aborted) return;
    const error = new Error("The client closed the inspection request");
    error.name = "AbortError";
    controller.abort(error);
  };
  request.once("aborted", abort);
  const events = response as ServerResponse & {
    once?: (event: string, listener: () => void) => unknown;
    off?: (event: string, listener: () => void) => unknown;
  };
  const onClose = () => {
    if (!response.writableEnded) abort();
  };
  events.once?.("close", onClose);
  return {
    signal: controller.signal,
    dispose() {
      request.off("aborted", abort);
      events.off?.("close", onClose);
    },
  };
}
