import { describe, expect, it } from "vitest";
import {
  fetchPullRequestViewedCoordinates,
  fetchPullRequestViewedFiles,
  setPullRequestFileViewed,
  setPullRequestFilesViewed,
} from "./github-pr-viewed";

const HEAD_SHA = "a".repeat(40);
const VIEWER_ID = "U_kgDOBoundViewer";

describe("fetchPullRequestViewedFiles", () => {
  it("loads every GraphQL page with stable PR, head, and viewer coordinates", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const responses = [
      viewedFilesPage({
        files: [
          { path: "src/one.ts", viewerViewedState: "VIEWED" },
          { path: "src/two.ts", viewerViewedState: "UNVIEWED" },
        ],
        hasNextPage: true,
        endCursor: "cursor-1",
      }),
      viewedFilesPage({
        files: [{ path: "src/three.ts", viewerViewedState: "DISMISSED" }],
        hasNextPage: false,
        endCursor: null,
      }),
    ];
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      return new Response(JSON.stringify(responses[calls.length - 1]), { status: 200 });
    }) as typeof fetch;

    const result = await fetchPullRequestViewedFiles(fetchImpl, {
      owner: "openai",
      repo: "meridian",
      prNumber: 42,
      token: "secret-token",
    });

    expect(result).toEqual({
      pullRequestId: "PR_42",
      headSha: HEAD_SHA,
      viewerId: VIEWER_ID,
      viewerLogin: "astrid",
      files: [
        { path: "src/one.ts", state: "VIEWED" },
        { path: "src/two.ts", state: "UNVIEWED" },
        { path: "src/three.ts", state: "DISMISSED" },
      ],
    });
    expect(calls).toHaveLength(2);
    expect(calls.map((call) => call.url)).toEqual([
      "https://api.github.com/graphql",
      "https://api.github.com/graphql",
    ]);
    expect(calls.map((call) => new Headers(call.init?.headers).get("authorization"))).toEqual([
      "Bearer secret-token",
      "Bearer secret-token",
    ]);
    expect(calls.map(graphqlBody)).toEqual([
      expect.objectContaining({
        variables: {
          owner: "openai",
          repo: "meridian",
          number: 42,
          first: 100,
          after: null,
        },
      }),
      expect.objectContaining({
        variables: {
          owner: "openai",
          repo: "meridian",
          number: 42,
          first: 100,
          after: "cursor-1",
        },
      }),
    ]);
    expect(JSON.stringify(calls.map(graphqlBody))).not.toContain("secret-token");
  });

  it.each([
    ["head", { headSha: "b".repeat(40) }],
    ["viewer", { viewerId: "U_kgDOAnotherViewer" }],
  ])("rejects a %s change between pages", async (_label, secondPageOverrides) => {
    let call = 0;
    const fetchImpl = (async () => {
      call += 1;
      return new Response(JSON.stringify(call === 1
        ? viewedFilesPage({
            files: [{ path: "src/one.ts", viewerViewedState: "VIEWED" }],
            hasNextPage: true,
            endCursor: "cursor-1",
          })
        : viewedFilesPage({
            files: [{ path: "src/two.ts", viewerViewedState: "UNVIEWED" }],
            hasNextPage: false,
            endCursor: null,
            ...secondPageOverrides,
          })), { status: 200 });
    }) as typeof fetch;

    await expect(fetchPullRequestViewedFiles(fetchImpl, {
      owner: "openai",
      repo: "meridian",
      prNumber: 42,
      token: "secret-token",
    })).rejects.toMatchObject({
      status: 409,
      message: "pull request head or viewer changed while loading viewed files; retry",
    });
  });

  it("keeps pagination bound to the immutable viewer id across a login rename", async () => {
    let call = 0;
    const fetchImpl = (async () => {
      call += 1;
      return new Response(JSON.stringify(viewedFilesPage({
        files: [{ path: call === 1 ? "src/one.ts" : "src/two.ts", viewerViewedState: "VIEWED" }],
        hasNextPage: call === 1,
        endCursor: call === 1 ? "cursor-1" : null,
        viewerLogin: call === 1 ? "astrid-old" : "astrid-new",
      })), { status: 200 });
    }) as typeof fetch;

    await expect(fetchPullRequestViewedFiles(fetchImpl, {
      owner: "openai",
      repo: "meridian",
      prNumber: 42,
      token: "secret-token",
    })).resolves.toMatchObject({
      viewerId: VIEWER_ID,
      viewerLogin: "astrid-new",
      files: [
        { path: "src/one.ts", state: "VIEWED" },
        { path: "src/two.ts", state: "VIEWED" },
      ],
    });
  });

  it("rejects a malformed viewed-file state with a provider-safe error", async () => {
    const fetchImpl = (async () => new Response(JSON.stringify(viewedFilesPage({
      files: [{ path: "src/one.ts", viewerViewedState: "UNKNOWN" }],
      hasNextPage: false,
      endCursor: null,
    })), { status: 200 })) as typeof fetch;

    await expect(fetchPullRequestViewedFiles(fetchImpl, {
      owner: "openai",
      repo: "meridian",
      prNumber: 42,
      token: "secret-token",
    })).rejects.toMatchObject({
      status: 502,
      message: "GitHub returned an invalid viewed-file state",
    });
  });
});

describe("fetchPullRequestViewedCoordinates", () => {
  it("loads only the PR, head, and active viewer needed for a write preflight", async () => {
    const bodies: Array<{ query: string; variables: Record<string, unknown> }> = [];
    const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)) as {
        query: string;
        variables: Record<string, unknown>;
      });
      return new Response(JSON.stringify(viewedFilesPage({
        files: [],
        hasNextPage: false,
        endCursor: null,
      })), { status: 200 });
    }) as typeof fetch;

    await expect(fetchPullRequestViewedCoordinates(fetchImpl, {
      owner: "openai",
      repo: "meridian",
      prNumber: 42,
      token: "secret-token",
    })).resolves.toEqual({
      pullRequestId: "PR_42",
      headSha: HEAD_SHA,
      viewerId: VIEWER_ID,
      viewerLogin: "astrid",
    });

    expect(bodies[0]?.query).toContain("query MeridianPullRequestViewedCoordinates");
    expect(bodies[0]?.query).not.toContain("files(");
    expect(bodies[0]?.variables).toEqual({ owner: "openai", repo: "meridian", number: 42 });
  });
});

describe("setPullRequestFileViewed", () => {
  it.each([
    [true, "markFileAsViewed", "unmarkFileAsViewed"],
    [false, "unmarkFileAsViewed", "markFileAsViewed"],
  ])("uses the correct mutation when viewed is %s", async (viewed, field, otherField) => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      return new Response(JSON.stringify({
        data: {
          update: {
            pullRequest: { headRefOid: HEAD_SHA },
          },
        },
      }), { status: 200 });
    }) as typeof fetch;

    await expect(setPullRequestFileViewed(fetchImpl, {
      pullRequestId: "PR_42",
      path: "src/one.ts",
      viewed,
      token: "secret-token",
    })).resolves.toEqual({ headSha: HEAD_SHA });

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://api.github.com/graphql");
    expect(calls[0].init?.method).toBe("POST");
    expect(new Headers(calls[0].init?.headers).get("authorization")).toBe("Bearer secret-token");
    const body = graphqlBody(calls[0]);
    expect(body.variables).toEqual({
      pullRequestId: "PR_42",
      path: "src/one.ts",
    });
    expect(body.query).toContain(`update: ${field}`);
    expect(body.query).not.toContain(`update: ${otherField}`);
    expect(JSON.stringify(body)).not.toContain("secret-token");
  });
});

describe("setPullRequestFilesViewed", () => {
  it("aliases a bounded mix of mark and unmark mutations into one GraphQL request", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      return new Response(JSON.stringify({
        data: {
          update0: { pullRequest: { headRefOid: HEAD_SHA } },
          update1: { pullRequest: { headRefOid: HEAD_SHA } },
        },
      }), { status: 200 });
    }) as typeof fetch;

    await expect(setPullRequestFilesViewed(fetchImpl, {
      pullRequestId: "PR_42",
      changes: [
        { path: "src/one.ts", viewed: true },
        { path: "src/two.ts", viewed: false },
      ],
      token: "secret-token",
    })).resolves.toEqual({ headSha: HEAD_SHA });

    expect(calls).toHaveLength(1);
    const body = graphqlBody(calls[0]);
    expect(body.query).toContain("mutation MeridianSetPullRequestFilesViewed");
    expect(body.query).toContain("update0: markFileAsViewed");
    expect(body.query).toContain("update1: unmarkFileAsViewed");
    expect(body.variables).toEqual({
      pullRequestId: "PR_42",
      path0: "src/one.ts",
      path1: "src/two.ts",
    });
  });
});

function viewedFilesPage(options: {
  files: Array<{ path: string; viewerViewedState: string }>;
  hasNextPage: boolean;
  endCursor: string | null;
  pullRequestId?: string;
  headSha?: string;
  viewerId?: string;
  viewerLogin?: string;
}): unknown {
  return {
    data: {
      viewer: {
        id: options.viewerId ?? VIEWER_ID,
        login: options.viewerLogin ?? "astrid",
      },
      repository: {
        pullRequest: {
          id: options.pullRequestId ?? "PR_42",
          headRefOid: options.headSha ?? HEAD_SHA,
          files: {
            nodes: options.files,
            pageInfo: {
              hasNextPage: options.hasNextPage,
              endCursor: options.endCursor,
            },
          },
        },
      },
    },
  };
}

function graphqlBody(call: { init?: RequestInit }): { query: string; variables: Record<string, unknown> } {
  return JSON.parse(String(call.init?.body)) as {
    query: string;
    variables: Record<string, unknown>;
  };
}
