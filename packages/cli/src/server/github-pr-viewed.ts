/**
 * GitHub-canonical, viewer-scoped PR file progress.
 *
 * REST exposes changed files but not the active user's Viewed checkbox. GraphQL is therefore the
 * source of truth for both the paginated read and the one-file mutation. Every page carries the
 * same PR/head/viewer coordinates so a push during pagination fails closed instead of producing a
 * mixed-revision file list.
 */

import { mutateGraphql, queryGraphql } from "./github-http";
import { WebError } from "./web-error";

const PAGE_SIZE = 100;
const MAX_PAGES = 30;
const GIT_OBJECT_ID = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/i;

export type PullRequestFileViewedState = "VIEWED" | "UNVIEWED" | "DISMISSED";

export interface PullRequestViewedFile {
  path: string;
  state: PullRequestFileViewedState;
}

export interface PullRequestViewedFiles {
  pullRequestId: string;
  headSha: string;
  viewerId: string;
  viewerLogin: string;
  files: PullRequestViewedFile[];
}

export interface PullRequestViewedFilesRequest {
  owner: string;
  repo: string;
  prNumber: number;
  token: string;
}

export interface SetPullRequestFileViewedRequest {
  pullRequestId: string;
  path: string;
  viewed: boolean;
  token: string;
}

export interface PullRequestFileViewedChange {
  path: string;
  viewed: boolean;
}

interface ViewedFilesPage extends Omit<PullRequestViewedFiles, "files"> {
  files: PullRequestViewedFile[];
  hasNextPage: boolean;
  endCursor: string | null;
}

const VIEWED_FILES_QUERY = `
query MeridianPullRequestViewedFiles(
  $owner: String!
  $repo: String!
  $number: Int!
  $first: Int!
  $after: String
) {
  viewer {
    id
    login
  }
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $number) {
      id
      headRefOid
      files(first: $first, after: $after) {
        nodes {
          path
          viewerViewedState
        }
        pageInfo {
          hasNextPage
          endCursor
        }
      }
    }
  }
}`;

const VIEWED_COORDINATES_QUERY = `
query MeridianPullRequestViewedCoordinates(
  $owner: String!
  $repo: String!
  $number: Int!
) {
  viewer {
    id
    login
  }
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $number) {
      id
      headRefOid
    }
  }
}`;

/** Lightweight write preflight binding the opaque PR id to this repo, head, and viewer. */
export async function fetchPullRequestViewedCoordinates(
  fetchImpl: typeof fetch,
  request: PullRequestViewedFilesRequest,
): Promise<Omit<PullRequestViewedFiles, "files">> {
  const json = await queryGraphql(fetchImpl, {
    query: VIEWED_COORDINATES_QUERY,
    variables: {
      owner: request.owner,
      repo: request.repo,
      number: request.prNumber,
    },
  }, request.token);
  return parseViewedCoordinates(json);
}

export async function fetchPullRequestViewedFiles(
  fetchImpl: typeof fetch,
  request: PullRequestViewedFilesRequest,
): Promise<PullRequestViewedFiles> {
  let after: string | null = null;
  let coordinates: Omit<PullRequestViewedFiles, "files"> | null = null;
  const files: PullRequestViewedFile[] = [];
  const paths = new Set<string>();

  for (let pageNumber = 1; pageNumber <= MAX_PAGES; pageNumber += 1) {
    const json = await queryGraphql(fetchImpl, {
      query: VIEWED_FILES_QUERY,
      variables: {
        owner: request.owner,
        repo: request.repo,
        number: request.prNumber,
        first: PAGE_SIZE,
        after,
      },
    }, request.token);
    const page = parseViewedFilesPage(json);
    const pageCoordinates = coordinatesOf(page);
    if (coordinates === null) {
      coordinates = pageCoordinates;
    } else if (!sameCoordinates(coordinates, pageCoordinates)) {
      throw new WebError(409, "pull request head or viewer changed while loading viewed files; retry");
    }
    for (const file of page.files) {
      if (paths.has(file.path)) {
        throw new WebError(502, "GitHub returned a duplicate pull request file path");
      }
      paths.add(file.path);
      files.push(file);
    }
    if (!page.hasNextPage) {
      return { ...pageCoordinates, files };
    }
    if (!page.endCursor || page.endCursor === after) {
      throw new WebError(502, "GitHub returned invalid pull request file pagination");
    }
    after = page.endCursor;
  }

  throw new WebError(502, "GitHub pull request file list exceeds Meridian's supported limit");
}

export async function setPullRequestFileViewed(
  fetchImpl: typeof fetch,
  request: SetPullRequestFileViewedRequest,
): Promise<{ headSha: string }> {
  const field = request.viewed ? "markFileAsViewed" : "unmarkFileAsViewed";
  const query = `
mutation MeridianSetPullRequestFileViewed($pullRequestId: ID!, $path: String!) {
  update: ${field}(input: { pullRequestId: $pullRequestId, path: $path }) {
    pullRequest { headRefOid }
  }
}`;
  const json = await mutateGraphql(fetchImpl, {
    query,
    variables: { pullRequestId: request.pullRequestId, path: request.path },
  }, request.token);
  const root = requiredObject(json, "GitHub viewed-file mutation response");
  const data = requiredObject(root.data, "GitHub viewed-file mutation data");
  const update = requiredObject(data.update, "GitHub viewed-file mutation result");
  const pullRequest = requiredObject(update.pullRequest, "GitHub viewed-file pull request");
  return { headSha: gitObjectId(pullRequest.headRefOid) };
}

/** Several file-atomic mutations in one GraphQL operation; top-level mutation fields run serially. */
export async function setPullRequestFilesViewed(
  fetchImpl: typeof fetch,
  request: {
    pullRequestId: string;
    changes: readonly PullRequestFileViewedChange[];
    token: string;
  },
): Promise<{ headSha: string }> {
  if (request.changes.length === 0) {
    throw new WebError(400, "at least one viewed-file change is required");
  }
  const variableDeclarations = request.changes
    .map((_, index) => `$path${index}: String!`)
    .join(", ");
  const fields = request.changes
    .map((change, index) => {
      const field = change.viewed ? "markFileAsViewed" : "unmarkFileAsViewed";
      return `update${index}: ${field}(input: { pullRequestId: $pullRequestId, path: $path${index} }) {
        pullRequest { headRefOid }
      }`;
    })
    .join("\n");
  const query = `
mutation MeridianSetPullRequestFilesViewed(
  $pullRequestId: ID!
  ${variableDeclarations}
) {
  ${fields}
}`;
  const variables: Record<string, unknown> = { pullRequestId: request.pullRequestId };
  request.changes.forEach((change, index) => {
    variables[`path${index}`] = change.path;
  });
  const json = await mutateGraphql(fetchImpl, { query, variables }, request.token);
  const root = requiredObject(json, "GitHub viewed-file batch mutation response");
  const data = requiredObject(root.data, "GitHub viewed-file batch mutation data");
  let headSha: string | null = null;
  request.changes.forEach((_, index) => {
    const update = requiredObject(data[`update${index}`], "GitHub viewed-file batch mutation result");
    const pullRequest = requiredObject(update.pullRequest, "GitHub viewed-file batch pull request");
    const updateHeadSha = gitObjectId(pullRequest.headRefOid);
    if (headSha !== null && headSha.toLowerCase() !== updateHeadSha.toLowerCase()) {
      throw new WebError(409, "pull request head changed during viewed-file batch mutation");
    }
    headSha = updateHeadSha;
  });
  return { headSha: headSha! };
}

function parseViewedFilesPage(json: unknown): ViewedFilesPage {
  const { coordinates, pullRequest } = parseViewedCoordinateObjects(json);
  const connection = requiredObject(pullRequest.files, "GitHub viewed-file connection");
  const pageInfo = requiredObject(connection.pageInfo, "GitHub viewed-file page info");
  if (!Array.isArray(connection.nodes) || typeof pageInfo.hasNextPage !== "boolean") {
    throw new WebError(502, "GitHub returned an invalid viewed-file connection");
  }
  const files = connection.nodes.map((node) => {
    const file = requiredObject(node, "GitHub viewed-file entry");
    return {
      path: requiredString(file.path, "GitHub viewed-file path"),
      state: viewedState(file.viewerViewedState),
    };
  });
  const endCursor = pageInfo.endCursor === null
    ? null
    : requiredString(pageInfo.endCursor, "GitHub viewed-file cursor");
  return {
    ...coordinates,
    files,
    hasNextPage: pageInfo.hasNextPage,
    endCursor,
  };
}

function parseViewedCoordinates(json: unknown): Omit<PullRequestViewedFiles, "files"> {
  return parseViewedCoordinateObjects(json).coordinates;
}

function parseViewedCoordinateObjects(json: unknown): {
  coordinates: Omit<PullRequestViewedFiles, "files">;
  pullRequest: Record<string, unknown>;
} {
  const root = requiredObject(json, "GitHub viewed-file response");
  const data = requiredObject(root.data, "GitHub viewed-file data");
  const viewer = requiredObject(data.viewer, "GitHub viewed-file viewer");
  const repository = nullableObject(data.repository);
  if (repository === null) {
    throw new WebError(404, "GitHub repository was not found or is unavailable");
  }
  const pullRequest = nullableObject(repository.pullRequest);
  if (pullRequest === null) {
    throw new WebError(404, "pull request was not found or is unavailable");
  }
  return {
    coordinates: {
      pullRequestId: requiredString(pullRequest.id, "GitHub pull request id"),
      headSha: gitObjectId(pullRequest.headRefOid),
      viewerId: requiredString(viewer.id, "GitHub viewer id"),
      viewerLogin: requiredString(viewer.login, "GitHub viewer login"),
    },
    pullRequest,
  };
}

function coordinatesOf(page: ViewedFilesPage): Omit<PullRequestViewedFiles, "files"> {
  return {
    pullRequestId: page.pullRequestId,
    headSha: page.headSha,
    viewerId: page.viewerId,
    viewerLogin: page.viewerLogin,
  };
}

function sameCoordinates(
  left: Omit<PullRequestViewedFiles, "files">,
  right: Omit<PullRequestViewedFiles, "files">,
): boolean {
  return left.pullRequestId === right.pullRequestId
    && left.headSha.toLowerCase() === right.headSha.toLowerCase()
    && left.viewerId === right.viewerId;
}

function viewedState(value: unknown): PullRequestFileViewedState {
  if (value === "VIEWED" || value === "UNVIEWED" || value === "DISMISSED") {
    return value;
  }
  throw new WebError(502, "GitHub returned an invalid viewed-file state");
}

function gitObjectId(value: unknown): string {
  const sha = requiredString(value, "GitHub pull request head");
  if (!GIT_OBJECT_ID.test(sha)) {
    throw new WebError(502, "GitHub returned an invalid pull request head");
  }
  return sha;
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new WebError(502, `${label} is missing`);
  }
  return value;
}

function requiredObject(value: unknown, label: string): Record<string, unknown> {
  const object = nullableObject(value);
  if (object === null) {
    throw new WebError(502, `${label} is invalid`);
  }
  return object;
}

function nullableObject(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}
