/**
 * Pull-request discovery before a blueprint exists. Unlike `/api/prs`, this route takes an exact
 * repository identity so the landing page can populate its PR picker without manufacturing an
 * artifact session first.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { parseRepoSlug } from "./github-parse";
import { sendJson } from "./http-response";
import { githubTokenFor } from "./web-auth";
import type { AuthContext } from "./web-auth";

export async function handleRepoPullRequests(
  ctx: AuthContext,
  request: IncomingMessage,
  response: ServerResponse,
  query: URLSearchParams,
): Promise<void> {
  const repository = query.get("repo") ?? "";
  const slug = parseLiteralRepoSlug(repository);
  if (!slug) {
    sendJson(response, 400, { error: "repo must be an exact owner/repo" });
    return;
  }

  const state = query.get("state");
  if (state !== "open" && state !== "closed") {
    sendJson(response, 400, { error: "state must be 'open' or 'closed'" });
    return;
  }

  const search = query.get("q")?.trim() ?? "";
  let page = 1;
  if (!search) {
    const rawPage = query.get("page");
    page = rawPage && /^[1-9]\d*$/.test(rawPage) ? Number(rawPage) : 0;
    if (!Number.isSafeInteger(page) || page <= 0) {
      sendJson(response, 400, { error: "page must be a positive integer" });
      return;
    }
  }

  const token = githubTokenFor(ctx, request);
  sendJson(response, 200, await ctx.github.listPullRequests({
    ...slug,
    state,
    page,
    token,
    includeViewerStatus: true,
    ...(search ? { query: search } : {}),
  }));
}

function parseLiteralRepoSlug(repository: string): { owner: string; repo: string } | null {
  const slug = parseRepoSlug(repository);
  return slug && `${slug.owner}/${slug.repo}` === repository ? slug : null;
}
