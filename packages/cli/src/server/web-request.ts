/**
 * Reading and validating the POST /api/generate request.
 *
 * Kept apart from the router so the server module stays about routing. The body is size-capped
 * (a local tool, but still never an unbounded read) and the deterministic id deliberately omits
 * the token so the same repo maps to the same graph regardless of how it was authenticated.
 */

import { createHash } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { SourceRequest } from "./clone";
import { WebError } from "./web-error";

const MAX_BODY_BYTES = 64_000;

export interface GenerateRequest extends SourceRequest {
  token?: string;
  refresh?: boolean;
}

export function readJsonBody(request: IncomingMessage): Promise<unknown> {
  return new Promise((resolveBody, rejectBody) => {
    let size = 0;
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        rejectBody(new WebError(413, "request body too large"));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => {
      try {
        resolveBody(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"));
      } catch {
        rejectBody(new WebError(400, "request body is not valid JSON"));
      }
    });
    request.on("error", () => rejectBody(new WebError(400, "could not read request body")));
  });
}

export function parseGenerateRequest(body: unknown): GenerateRequest {
  if (typeof body !== "object" || body === null) {
    throw new WebError(400, "request body must be a JSON object");
  }
  const raw = body as Record<string, unknown>;
  if (raw.kind !== "github" && raw.kind !== "path") {
    throw new WebError(400, "kind must be 'github' or 'path'");
  }
  if (typeof raw.value !== "string" || raw.value.trim() === "") {
    throw new WebError(400, "value is required");
  }
  return {
    kind: raw.kind,
    value: raw.value,
    ref: optionalString(raw.ref),
    subdir: optionalString(raw.subdir),
    token: optionalString(raw.token),
    refresh: raw.refresh === true,
  };
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

/** Deterministic short id from the source identity — token deliberately excluded. */
export function artifactId(request: GenerateRequest, commit = "", analysisKey = ""): string {
  const key = [
    request.kind,
    request.value,
    request.ref ?? "",
    request.subdir ?? "",
    commit,
    analysisKey,
  ].join(" ");
  return createHash("sha1").update(key).digest("hex").slice(0, 12);
}

/** Remote graph ids use canonical cache identity so equivalent repository spellings converge. */
export function remoteArtifactId(repositoryKey: string, commit: string, analysisKey: string): string {
  return createHash("sha1").update([repositoryKey, commit, analysisKey].join(" ")).digest("hex").slice(0, 12);
}
