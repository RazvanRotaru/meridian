import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import type { ExtractionResult, GraphEdge } from "@meridian/core";
import { createPythonExtractor } from "./index";

async function withProject<T>(files: Record<string, string>, run: (root: string) => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), "meridian-python-protocols-"));
  try {
    for (const [file, source] of Object.entries(files)) {
      const path = join(root, file);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, source);
    }
    return await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function extract(root: string): Promise<ExtractionResult> {
  return createPythonExtractor().extract({ root });
}

function edge(
  result: ExtractionResult,
  kind: GraphEdge["kind"],
  source: string,
  target: string,
): GraphEdge | undefined {
  return result.edges.find(
    (candidate) =>
      candidate.kind === kind &&
      candidate.resolution === "resolved" &&
      candidate.source === source &&
      candidate.target === target,
  );
}

describe("PythonExtractor Protocol relationships", () => {
  it("links the concrete constructor returned by a Protocol-typed factory", async () => {
    await withProject(
      {
        "recorder.py": [
          "from typing import Protocol",
          "",
          "class E2ERecorder(Protocol):",
          "    def record(self, payload: str) -> None: ...",
          "",
          "class _RequestRecorder:",
          "    def record(self, payload: str) -> None:",
          "        pass",
          "",
          "class Helper:",
          "    pass",
          "",
          "def maybe_create_recorder(enabled: bool) -> E2ERecorder | None:",
          "    Helper()",
          "    if not enabled:",
          "        return None",
          "    return _RequestRecorder()",
          "",
        ].join("\n"),
      },
      async (root) => {
        const result = await extract(root);
        const factory = "py:recorder#maybe_create_recorder";
        const contract = "py:recorder#E2ERecorder";
        const implementation = "py:recorder#_RequestRecorder";
        const helper = "py:recorder#Helper";

        expect(result.nodes).toContainEqual(expect.objectContaining({ id: contract, kind: "interface" }));
        expect(edge(result, "references", factory, contract)).toBeDefined();
        expect(edge(result, "instantiates", factory, helper)).toBeDefined();
        expect(edge(result, "instantiates", factory, implementation)).toBeDefined();

        const inferred = edge(result, "implements", implementation, contract);
        expect(inferred).toMatchObject({
          id: `implements@${implementation}|${contract}`,
          confidence: 0.8,
          callSites: [expect.objectContaining({ file: "recorder.py", line: 17, col: 12 })],
        });
        expect(edge(result, "implements", helper, contract)).toBeUndefined();
      },
    );
  });

  it("uses implements for a concrete Protocol base and extends between Protocols", async () => {
    await withProject(
      {
        "inheritance.py": [
          "from typing import Protocol as Contract",
          "",
          "class Parent(Contract):",
          "    def run(self) -> None: ...",
          "",
          "class ChildProtocol(Parent, Contract):",
          "    def stop(self) -> None: ...",
          "",
          "class Explicit(Parent):",
          "    def run(self) -> None:",
          "        pass",
          "",
          "class Base:",
          "    pass",
          "",
          "class Child(Base):",
          "    pass",
          "",
        ].join("\n"),
      },
      async (root) => {
        const result = await extract(root);

        expect(result.nodes).toContainEqual(
          expect.objectContaining({ id: "py:inheritance#Parent", kind: "interface" }),
        );
        expect(result.nodes).toContainEqual(
          expect.objectContaining({ id: "py:inheritance#ChildProtocol", kind: "interface" }),
        );
        expect(edge(result, "extends", "py:inheritance#ChildProtocol", "py:inheritance#Parent")).toBeDefined();
        expect(edge(result, "implements", "py:inheritance#ChildProtocol", "py:inheritance#Parent")).toBeUndefined();
        expect(edge(result, "implements", "py:inheritance#Explicit", "py:inheritance#Parent")).toMatchObject({
          confidence: 1,
        });
        expect(edge(result, "extends", "py:inheritance#Explicit", "py:inheritance#Parent")).toBeUndefined();
        expect(edge(result, "extends", "py:inheritance#Child", "py:inheritance#Base")).toBeDefined();
      },
    );
  });

  it("resolves an imported returned implementation as the edge source", async () => {
    await withProject(
      {
        "compat.py": "from typing_extensions import Protocol\n",
        "contracts.py": [
          "from compat import Protocol",
          "",
          "class Recorder(Protocol):",
          "    def record(self) -> None: ...",
          "",
        ].join("\n"),
        "implementation.py": [
          "class RequestRecorder:",
          "    def record(self) -> None:",
          "        pass",
          "",
        ].join("\n"),
        "factory.py": [
          "from contracts import Recorder",
          "from implementation import RequestRecorder",
          "from helpers import build",
          "",
          "def create() -> Recorder:",
          "    return RequestRecorder()",
          "",
          "def create_indirectly() -> Recorder:",
          "    return build()",
          "",
        ].join("\n"),
        "helpers.py": "def build():\n    return object()\n",
      },
      async (root) => {
        const result = await extract(root);
        const contract = "py:contracts#Recorder";
        const implementation = "py:implementation#RequestRecorder";
        const factory = "py:factory#create";

        expect(result.nodes).toContainEqual(expect.objectContaining({ id: contract, kind: "interface" }));
        expect(edge(result, "references", factory, contract)).toBeDefined();
        expect(edge(result, "instantiates", factory, implementation)).toBeDefined();
        expect(edge(result, "implements", implementation, contract)).toMatchObject({
          confidence: 0.8,
          callSites: [expect.objectContaining({ file: "factory.py", line: 6 })],
        });
        expect(edge(result, "implements", "py:helpers#build", contract)).toBeUndefined();
      },
    );
  });

  it("keeps Protocol identity attached to the exact class occurrence", async () => {
    await withProject(
      {
        "duplicates.py": [
          "from typing import Protocol",
          "",
          "class Contract(Protocol):",
          "    def run(self) -> None: ...",
          "",
          "class Implementation:",
          "    def run(self) -> None:",
          "        pass",
          "",
          "def create() -> Contract:",
          "    return Implementation()",
          "",
          "class Contract:",
          "    pass",
          "",
        ].join("\n"),
      },
      async (root) => {
        const result = await extract(root);
        const firstContract = "py:duplicates#Contract";
        const reboundContract = "py:duplicates#Contract~1";
        const implementation = "py:duplicates#Implementation";

        expect(result.nodes).toContainEqual(expect.objectContaining({ id: firstContract, kind: "interface" }));
        expect(result.nodes).toContainEqual(expect.objectContaining({ id: reboundContract, kind: "class" }));
        expect(edge(result, "implements", implementation, firstContract)).toBeDefined();
        expect(edge(result, "implements", implementation, reboundContract)).toBeUndefined();
      },
    );
  });

  it("keeps return contracts attached to duplicate callable occurrences", async () => {
    await withProject(
      {
        "duplicate_factories.py": [
          "from typing import Protocol",
          "",
          "class FirstContract(Protocol):",
          "    def first(self) -> None: ...",
          "",
          "class SecondContract(Protocol):",
          "    def second(self) -> None: ...",
          "",
          "class FirstImplementation:",
          "    def first(self) -> None: pass",
          "",
          "class SecondImplementation:",
          "    def second(self) -> None: pass",
          "",
          "def create() -> FirstContract:",
          "    return FirstImplementation()",
          "",
          "def create() -> SecondContract:",
          "    return SecondImplementation()",
          "",
        ].join("\n"),
      },
      async (root) => {
        const result = await extract(root);
        const first = "py:duplicate_factories#FirstImplementation";
        const second = "py:duplicate_factories#SecondImplementation";
        const firstContract = "py:duplicate_factories#FirstContract";
        const secondContract = "py:duplicate_factories#SecondContract";

        expect(edge(result, "implements", first, firstContract)).toBeDefined();
        expect(edge(result, "implements", second, secondContract)).toBeDefined();
        expect(edge(result, "implements", first, secondContract)).toBeUndefined();
        expect(edge(result, "implements", second, firstContract)).toBeUndefined();
      },
    );
  });

  it("does not guess through ambiguous nested types or function-local shadows", async () => {
    await withProject(
      {
        "nested.py": [
          "from typing import Protocol",
          "",
          "class GlobalContract(Protocol):",
          "    def run(self) -> None: ...",
          "",
          "class Implementation:",
          "    def run(self) -> None: pass",
          "",
          "class Outer:",
          "    class Contract(Protocol):",
          "        def run(self) -> None: ...",
          "    class Contract:",
          "        pass",
          "",
          "def ambiguous() -> Outer.Contract:",
          "    return Implementation()",
          "",
          "def shadowed(GlobalContract):",
          "    class LocalContract(GlobalContract):",
          "        pass",
          "    def create() -> GlobalContract:",
          "        return Implementation()",
          "    return create()",
          "",
        ].join("\n"),
      },
      async (root) => {
        const result = await extract(root);
        const implementation = "py:nested#Implementation";

        expect(result.nodes).toContainEqual(
          expect.objectContaining({ id: "py:nested#Outer.Contract", kind: "interface" }),
        );
        expect(result.nodes).toContainEqual(
          expect.objectContaining({ id: "py:nested#Outer.Contract~1", kind: "class" }),
        );
        expect(result.nodes).toContainEqual(
          expect.objectContaining({ id: "py:nested#shadowed.LocalContract", kind: "class" }),
        );
        expect(edge(result, "implements", implementation, "py:nested#Outer.Contract")).toBeUndefined();
        expect(edge(result, "implements", implementation, "py:nested#Outer.Contract~1")).toBeUndefined();
        expect(edge(result, "implements", implementation, "py:nested#GlobalContract")).toBeUndefined();
      },
    );
  });
});
