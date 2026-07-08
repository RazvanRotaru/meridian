import type { IncomingMessage, ServerResponse } from "node:http";
import { fetchPullRequestFiles, listPullRequests } from "./github";
import { sendJson } from "./http-response";
import { githubTokenFor } from "./web-auth";
import { WebError } from "./web-error";
import type { Context } from "./web-server";
import type { ArtifactSource } from "./web-source";
import { stripExtractionSubdir } from "./web-source";

const GITHUB_SOURCE_ERROR = "pull requests need a GitHub-sourced session";

export async function handlePullRequests(
  ctx: Context,
  request: IncomingMessage,
  response: ServerResponse,
  query: URLSearchParams,
): Promise<void> {
  const source = githubSource(ctx, query.get("id"));
  if (!source) {
    sendJson(response, 404, { error: GITHUB_SOURCE_ERROR });
    return;
  }
  const state = parseState(query.get("state"));
  const page = parsePositiveInt(query.get("page"), "page");
  const token = githubTokenFor(ctx, request);
  const result = await listPullRequests({ owner: source.owner, repo: source.repo, state, page, token });
  sendJson(response, 200, result);
}

export async function handlePullRequestFiles(
  ctx: Context,
  request: IncomingMessage,
  response: ServerResponse,
  query: URLSearchParams,
): Promise<void> {
  const source = githubSource(ctx, query.get("id"));
  if (!source) {
    sendJson(response, 404, { error: GITHUB_SOURCE_ERROR });
    return;
  }
  const prNumber = parsePositiveInt(query.get("n"), "n");
  const result = await fetchPullRequestFiles({ owner: source.owner, repo: source.repo, prNumber, token: githubTokenFor(ctx, request) });
  sendJson(response, 200, { files: stripExtractionSubdir(result.files, source.subdir), truncated: result.truncated });
}

function githubSource(ctx: Context, id: string | null): Extract<ArtifactSource, { kind: "github" }> | null {
  const source = id ? ctx.sources.get(id) : undefined;
  return source?.kind === "github" ? source : null;
}

function parseState(state: string | null): "open" | "closed" {
  if (state === "open" || state === "closed") {
    return state;
  }
  throw new WebError(400, "state must be 'open' or 'closed'");
}

function parsePositiveInt(raw: string | null, name: string): number {
  const value = raw && /^[1-9]\d*$/.test(raw) ? Number(raw) : 0;
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new WebError(400, `${name} must be a positive integer`);
  }
  return value;
}
