import { describe, expect, it } from "vitest";
import { PassThrough } from "node:stream";
import type { IncomingMessage } from "node:http";
import { SCHEMA_VERSION } from "@meridian/core";
import type { GraphArtifact } from "@meridian/core";
import { materializeValidatedArtifact } from "./web-graph-store";
import { localArtifactId, parseGenerateRequest, readJsonBody, remoteArtifactId } from "./web-request";

const ARTIFACT: GraphArtifact = {
  schemaVersion: SCHEMA_VERSION,
  generatedAt: "2026-07-20T00:00:00.000Z",
  generator: { name: "meridian", version: "test" },
  target: { name: "repo", root: ".", language: "typescript" },
  nodes: [],
  edges: [],
};
const NO_SYNTHETIC = { scenarios: [], sourceFingerprint: null, trust: null } as const;

describe("web graph identity", () => {
  it("ignores the retired language selector and keeps one canonical analysis identity", () => {
    const typescript = parseGenerateRequest({ kind: "path", value: "/repo", lang: "typescript" });
    const python = parseGenerateRequest({ kind: "path", value: "/repo", lang: "python" });

    expect(typescript).not.toHaveProperty("lang");
    expect(python).not.toHaveProperty("lang");
    const digest = materializeValidatedArtifact(ARTIFACT).byteDigest;
    expect(localArtifactId("/repo", digest, NO_SYNTHETIC))
      .toBe(localArtifactId("/repo", digest, NO_SYNTHETIC));
  });

  it("keeps a local id stable only for the same source, artifact, and capability", () => {
    const artifactDigest = (artifact: GraphArtifact) => materializeValidatedArtifact(artifact).byteDigest;
    const stable = localArtifactId("/repo", artifactDigest(ARTIFACT), NO_SYNTHETIC);

    expect(localArtifactId("/repo", artifactDigest({ ...ARTIFACT }), NO_SYNTHETIC)).toBe(stable);
    expect(localArtifactId("/other-repo", artifactDigest(ARTIFACT), NO_SYNTHETIC)).not.toBe(stable);
    expect(localArtifactId(
      "/repo",
      artifactDigest({ ...ARTIFACT, generatedAt: "2026-07-20T00:00:01.000Z" }),
      NO_SYNTHETIC,
    )).not.toBe(stable);
    expect(localArtifactId("/repo", artifactDigest({
      ...ARTIFACT,
      nodes: [{
        id: "ts:src/index.ts",
        kind: "module",
        displayName: "index.ts",
        qualifiedName: "src/index.ts",
        location: { file: "src/index.ts", startLine: 1, endLine: 1 },
      }],
    }), NO_SYNTHETIC)).not.toBe(stable);
    expect(localArtifactId("/repo", artifactDigest(ARTIFACT), {
      scenarios: [],
      sourceFingerprint: null,
      trust: { mode: "local" },
    })).not.toBe(stable);
  });

  it("keeps remote ref provenance in the id while sharing commit analysis identity", () => {
    const digest = "b".repeat(64);
    const head = remoteArtifactId("repository", "a".repeat(40), "analysis", undefined, digest);
    const main = remoteArtifactId("repository", "a".repeat(40), "analysis", "main", digest);

    expect(remoteArtifactId("repository", "a".repeat(40), "analysis", undefined, digest)).toBe(head);
    expect(remoteArtifactId("repository", "a".repeat(40), "analysis", "main", digest)).toBe(main);
    expect(main).not.toBe(head);
    expect(remoteArtifactId("repository", "a".repeat(40), "analysis", "release", digest)).not.toBe(main);
    expect(remoteArtifactId("repository", "a".repeat(40), "analysis", "main", "c".repeat(64)))
      .not.toBe(main);
  });
});

describe("readJsonBody lifecycle", () => {
  it("aborts an incomplete body and removes every stream listener", async () => {
    const stream = new PassThrough();
    const request = stream as unknown as IncomingMessage;
    const controller = new AbortController();
    const reason = new Error("owned shutdown");
    const body = readJsonBody(request, controller.signal);
    stream.write('{"partial":');

    controller.abort(reason);

    await expect(body).rejects.toBe(reason);
    expect(request.destroyed).toBe(true);
    expect(request.listenerCount("data")).toBe(0);
    expect(request.listenerCount("end")).toBe(0);
    expect(request.listenerCount("error")).toBe(0);
  });
});
