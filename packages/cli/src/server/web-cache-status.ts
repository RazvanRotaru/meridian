import type { IncomingMessage, ServerResponse } from "node:http";
import { sendJson } from "./http-response";
import { githubTokenFor } from "./web-auth";
import type { AuthContext } from "./web-auth";
import { probeRemoteGraph } from "./web-cache-probe";
import type { RepositoryMirror } from "./web-repository-mirror";

interface CacheStatusContext extends AuthContext {
  shutdownSignal: AbortSignal;
  cacheRoot: string;
  repositories: RepositoryMirror;
  cwd: string;
  refreshCache: boolean;
}

export async function handleCacheStatus(
  ctx: CacheStatusContext,
  request: IncomingMessage,
  response: ServerResponse,
  query: URLSearchParams,
): Promise<void> {
  const repository = query.get("repo")?.trim() ?? "";
  const ref = query.get("ref")?.trim() || undefined;
  const subdir = query.get("subdir")?.trim() || undefined;
  const result = await probeRemoteGraph({
    cacheRoot: ctx.cacheRoot,
    repositories: ctx.repositories,
    request: { kind: "github", value: repository, ref, subdir, refresh: ctx.refreshCache },
    cwd: ctx.cwd,
    token: githubTokenFor(ctx, request),
    signal: ctx.shutdownSignal,
  });
  sendJson(response, 200, result);
}
