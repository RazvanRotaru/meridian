/** Strict, versioned NDJSON transport for two-sided pull-request preparation. */

import { createHash } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import {
  PR_PREPARE_MAX_LINE_BYTES,
  PR_PREPARE_PROTOCOL_VERSION,
  PR_PREPARE_V1_FIELDS,
  hasExactPrPrepareFields,
  isPrPrepareElapsedMs,
  isPrPrepareStage,
  normalizePrPrepareTimings,
  normalizePrPrepareWarnings,
} from "@meridian/core";
import { CliError } from "../errors";
import { githubTokenFor } from "./web-auth";
import { WebError } from "./web-error";
import { cancelWhenClientLeaves } from "./web-cancellation";
import { readJsonBody } from "./web-request";
import { parsePrPrepareRequest, sourceForPrPrepare } from "./web-pr-request";
import type { PrPrepareRequest } from "./web-pr-request";
import type { Context } from "./web-server";
import { InspectionQueueFullError } from "./inspection-scheduler";
import {
  acquirePrPreparationSourceOperations,
  type CachedPrPreparation,
  type CachedPrSide,
  type PrPrepareProgress,
} from "./web-pr-cache";
import type { GraphGenerationSummary } from "./graph-generation-contract";
import type { GraphRevisionIdentity, VerifiedGraphGeneration } from "./graph-generation-verifier";
import type { PublishGraphCapability } from "./graph-capability-store";
import {
  PreparedReviewHandoffStoreError,
  type PreparedReviewGraphDescriptor,
} from "./prepared-review-handoff-store";
import {
  readSyntheticCapabilitySidecar,
  syntheticCapabilitySidecarPath,
} from "./synthetic-capability-sidecar";
import { withOwnershipCleanup } from "./ownership-cleanup";

export type PreparedGraphDescriptor = PreparedReviewGraphDescriptor;

async function acquirePreparedGenerationLeases(
  ctx: Context,
  prepared: CachedPrPreparation,
  signal?: AbortSignal,
) {
  const head = await ctx.graphGenerationLifecycle.acquire(
    prepared.head.verifiedGeneration.generationDirectory,
    { purpose: "publication", signal },
  );
  try {
    const mergeBase = await ctx.graphGenerationLifecycle.acquire(
      prepared.mergeBase.verifiedGeneration.generationDirectory,
      { purpose: "publication", signal },
    );
    return [head, mergeBase] as const;
  } catch (error) {
    await withOwnershipCleanup(
      () => { throw error; },
      [() => head.release()],
      "PR generation lease acquisition",
    );
    throw error;
  }
}

export async function handlePrPrepare(
  ctx: Context,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  const body = parsePrPrepareRequest(await readJsonBody({ request, signal: ctx.shutdownSignal }));
  const token = githubTokenFor(ctx, request);
  const cancellation = cancelWhenClientLeaves(request, response);
  const operationSignal = AbortSignal.any([cancellation.signal, ctx.shutdownSignal]);
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
          baseInspectionCoordinator: ctx.prBaseInspectionCoordinator,
          generationLifecycle: ctx.graphGenerationLifecycle,
          runExtraction: ctx.runExtraction,
        },
        {
          signal: operationSignal,
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
      const descriptors = describePreparedGraphs(body, prepared);
      const candidate = ctx.preparedReviewHandoffs.prepare({
        request: body,
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
      const document = candidate.document;
      const done = {
        version: PR_PREPARE_PROTOCOL_VERSION,
        type: "done",
        headSha: document.headSha,
        baseSha: document.baseSha,
        mergeBaseSha: document.mergeBaseSha,
        changedFiles: document.changedFiles,
        head: document.head,
        mergeBase: document.mergeBase,
        cache: document.cache,
        timings: document.timings,
        warnings: document.warnings,
        handoff: candidate.reference,
      };
      // Validate the exact terminal line before durable graph publication. This avoids leaving
      // capabilities that the strict 2 MiB NDJSON transport can never return to their creator.
      const serializedDone = serializeLine(done);
      const generationLeases = await acquirePreparedGenerationLeases(ctx, prepared, operationSignal);
      await withOwnershipCleanup(
        async () => {
          const sourceOperations = await acquirePrPreparationSourceOperations(
            ctx.repositoryMirrors,
            prepared,
            operationSignal,
          );
          await withOwnershipCleanup(
            () => publishCapabilitySides(
              ctx,
              body,
              prepared,
              descriptors,
              AbortSignal.any([
                operationSignal,
                sourceOperations[0].signal,
                sourceOperations[1].signal,
              ]),
            ),
            [
              () => sourceOperations[0].release(),
              () => sourceOperations[1].release(),
            ],
            "PR source capability publication",
          );
        },
        [
          () => generationLeases[0].release(),
          () => generationLeases[1].release(),
        ],
        "PR generation capability publication",
      );
      // Handoff publication can synchronously deliver the terminal record. Every transient source
      // and generation lease has therefore been released successfully before entering this call.
      await ctx.preparedReviewHandoffs.publish(candidate, {
        signal: operationSignal,
        deliver: () => {
          writeSerializedLine(response, serializedDone);
          return undefined;
        },
      });
      if (prepared.cache === "miss") {
        ctx.graphGenerationMaintenance.notePublication();
        ctx.graphGenerationMaintenance.notePublication();
      }
    } catch (error) {
      if (!operationSignal.aborted) {
        writeLine(response, {
          version: PR_PREPARE_PROTOCOL_VERSION,
          type: "error",
          message: safeMessage(error),
        });
      }
    } finally {
      response.end();
    }
  } finally {
    cancellation.dispose();
  }
}

function describePreparedGraphs(
  request: PrPrepareRequest,
  prepared: CachedPrPreparation,
): { head: PreparedGraphDescriptor; mergeBase: PreparedGraphDescriptor } {
  const sharedIdentity = {
    repositoryKey: prepared.repositoryKey,
    securityDigest: prepared.securityDigest,
    subdir: request.subdir ?? "",
    analysisKey: prepared.analysisKey,
    headSha: prepared.headSha,
    mergeBaseSha: prepared.mergeBaseSha,
    reviewContextSha256: prepared.reviewContext.sha256,
  };
  const headId = graphId("head", {
    ...sharedIdentity,
    graph: immutableGraphIdentity(prepared.head.verifiedGeneration),
  });
  const mergeBaseId = graphId("base", {
    ...sharedIdentity,
    graph: immutableGraphIdentity(prepared.mergeBase.verifiedGeneration),
  });
  return {
    head: descriptorFor(headId, prepared.head.verifiedGeneration.graphSummary),
    mergeBase: descriptorFor(mergeBaseId, prepared.mergeBase.verifiedGeneration.graphSummary),
  };
}

async function publishCapabilitySides(
  ctx: Context,
  request: PrPrepareRequest,
  prepared: CachedPrPreparation,
  descriptors: { head: PreparedGraphDescriptor; mergeBase: PreparedGraphDescriptor },
  signal?: AbortSignal,
): Promise<void> {
  const source = sourceForPrPrepare(request);
  await ctx.graphCapabilities.publishMany([
    capabilityForSide(
      descriptors.mergeBase.graphId,
      prepared.mergeBase,
      source,
      request.subdir,
      {
        reference: prepared.reviewContext,
        side: "mergeBase",
        peerGraphId: descriptors.head.graphId,
        generation: prepared.head.verifiedGeneration,
      },
    ),
    capabilityForSide(
      descriptors.head.graphId,
      prepared.head,
      source,
      request.subdir,
      {
        reference: prepared.reviewContext,
        side: "head",
        peerGraphId: descriptors.mergeBase.graphId,
        generation: prepared.head.verifiedGeneration,
      },
      prepared.headSha,
    ),
  ], { signal, idempotence: "managed-cache-semantic" });
}

function capabilityForSide(
  graphId: string,
  side: CachedPrSide,
  source: ReturnType<typeof sourceForPrPrepare>,
  subdir: string | undefined,
  reviewContext: NonNullable<PublishGraphCapability["reviewContext"]>,
  preparedHeadSha?: string,
): PublishGraphCapability {
  const synthetic = readSyntheticCapabilitySidecar(syntheticCapabilitySidecarPath(side.artifactPath));
  const canExecute = preparedHeadSha !== undefined
    && synthetic?.state === "ready"
    && synthetic.scenarios.length > 0
    && synthetic.sourceFingerprint !== null;
  return {
    id: graphId,
    generation: side.verifiedGeneration,
    sourceRoot: side.sourceRoot,
    sourceLease: side.sourceLease,
    ...(subdir ? { sourceSubdir: subdir } : {}),
    source,
    reviewContext,
    ...(canExecute ? {
      syntheticExecutionTrust: {
        mode: "sandboxed-pr" as const,
        provenance: {
          repository: `${source.owner}/${source.repo}`,
          headSha: preparedHeadSha,
        },
      },
    } : {}),
  };
}

function descriptorFor(graphId: string, graphSummary: GraphGenerationSummary): PreparedGraphDescriptor {
  const id = encodeURIComponent(graphId);
  return {
    graphId,
    manifestUrl: `/api/graph/manifest?id=${id}`,
    projectionUrl: `/api/graph/projection?id=${id}`,
    searchUrl: `/api/graph/search?id=${id}`,
    sourceUrl: `/api/source?id=${id}`,
    metaUrl: `/api/meta?id=${id}`,
    graphSummary,
  };
}

interface ImmutableGraphIdentity {
  readonly artifact: { readonly bytes: number; readonly sha256: string };
  readonly projection: {
    readonly bytes: number;
    readonly sha256: string;
    readonly contentId: string;
  };
  readonly revision: GraphRevisionIdentity;
  readonly summary: GraphGenerationSummary;
}

interface PreparedGraphIdIdentity {
  readonly repositoryKey: string;
  readonly securityDigest: string;
  readonly subdir: string;
  readonly analysisKey: string;
  readonly headSha: string;
  readonly mergeBaseSha: string;
  readonly reviewContextSha256: string;
  readonly graph: ImmutableGraphIdentity;
}

function immutableGraphIdentity(generation: VerifiedGraphGeneration): ImmutableGraphIdentity {
  const revision: GraphRevisionIdentity = generation.revision.kind === "git"
    ? { kind: "git", commit: generation.revision.commit }
    : { kind: "content", contentId: generation.revision.contentId };
  return {
    artifact: { bytes: generation.artifactBytes, sha256: generation.artifactSha256 },
    projection: {
      bytes: generation.projectionBytes,
      sha256: generation.projectionSha256,
      contentId: generation.projectionContentId,
    },
    revision,
    summary: {
      schemaVersion: generation.graphSummary.schemaVersion,
      generatedAt: generation.graphSummary.generatedAt,
      nodeCount: generation.graphSummary.nodeCount,
      edgeCount: generation.graphSummary.edgeCount,
    },
  };
}

function graphId(
  side: "head" | "base",
  identity: PreparedGraphIdIdentity,
): string {
  const digest = createHash("sha256")
    .update(JSON.stringify({ version: 2, side, ...identity }))
    .digest("hex");
  const revision = identity.graph.revision;
  const revisionId = revision.kind === "git" ? revision.commit : revision.contentId;
  return `pr-${side}-${digest}-${revisionId.slice(0, 16)}`;
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
    version: PR_PREPARE_PROTOCOL_VERSION,
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
  writeSerializedLine(response, serializeLine(line));
}

function serializeLine(line: Record<string, unknown>): string {
  assertPrPrepareV1Line(line);
  const serialized = JSON.stringify(line);
  if (Buffer.byteLength(`${serialized}\n`, "utf8") > PR_PREPARE_MAX_LINE_BYTES) {
    throw new WebError(422, "PR preparation result exceeds the 2 MiB NDJSON line limit");
  }
  return serialized;
}

function assertPrPrepareV1Line(line: Record<string, unknown>): void {
  if (line.version !== PR_PREPARE_PROTOCOL_VERSION) throw invalidProtocolRecord();
  if (line.type === "progress") {
    if (!hasExactPrPrepareFields(line, PR_PREPARE_V1_FIELDS.progress)
      || !isPrPrepareStage(line.stage)
      || !isPrPrepareElapsedMs(line.elapsedMs)) throw invalidProtocolRecord();
    return;
  }
  if (line.type === "done") {
    if (!hasExactPrPrepareFields(line, PR_PREPARE_V1_FIELDS.done)
      || normalizePrPrepareTimings(line.timings) === null
      || normalizePrPrepareWarnings(line.warnings) === null) throw invalidProtocolRecord();
    return;
  }
  if (line.type === "error") {
    if (!hasExactPrPrepareFields(line, PR_PREPARE_V1_FIELDS.error)
      || typeof line.message !== "string"
      || line.message.length === 0) throw invalidProtocolRecord();
    return;
  }
  throw invalidProtocolRecord();
}

function invalidProtocolRecord(): TypeError {
  return new TypeError("invalid internal PR preparation protocol record");
}

function writeSerializedLine(response: ServerResponse, serialized: string): void {
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
  if (error instanceof WebError || error instanceof CliError || error instanceof PreparedReviewHandoffStoreError) {
    return error.message;
  }
  return "internal error while preparing the pull request";
}
