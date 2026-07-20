import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { analyzeRepository } from "./repository-analysis";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("canonical repository analysis Python Protocol semantics", () => {
  it("emits the inferred implementation relationship in the cacheable product artifact", async () => {
    const root = await mkdtemp(join(tmpdir(), "meridian-repository-protocol-"));
    temporaryRoots.push(root);
    await writeFile(join(root, "recorder.py"), [
      "from typing import Protocol",
      "",
      "class Recorder(Protocol):",
      "    def record(self, payload: str) -> None: ...",
      "",
      "class RequestRecorder:",
      "    def record(self, payload: str) -> None:",
      "        pass",
      "",
      "def create_recorder() -> Recorder:",
      "    return RequestRecorder()",
      "",
    ].join("\n"));

    const { artifact } = await analyzeRepository({
      absoluteRoot: root,
      cwd: root,
      targetName: "protocol-fixture",
    });

    const contract = "py:recorder#Recorder";
    const implementation = "py:recorder#RequestRecorder";
    const factory = "py:recorder#create_recorder";
    expect(artifact.nodes).toContainEqual(expect.objectContaining({ id: contract, kind: "interface" }));
    expect(artifact.edges).toContainEqual(expect.objectContaining({
      id: `implements@${implementation}|${contract}`,
      kind: "implements",
      source: implementation,
      target: contract,
      resolution: "resolved",
      confidence: 0.8,
    }));
    expect(artifact.edges).toContainEqual(expect.objectContaining({
      kind: "references",
      source: factory,
      target: contract,
    }));
    expect(artifact.edges).toContainEqual(expect.objectContaining({
      kind: "instantiates",
      source: factory,
      target: implementation,
    }));
  });
});
