import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { computeAffectedFlows } from "@meridian/core";
import type { FlowStep } from "@meridian/core";
import { describe, expect, it } from "vitest";
import { createPythonExtractor } from "./index";

async function extractSource(source: string) {
  const root = await mkdtemp(join(tmpdir(), "meridian-python-logic-flows-"));
  try {
    await writeFile(join(root, "service.py"), source);
    return await createPythonExtractor().extract({ root });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function flatten(steps: readonly FlowStep[]): FlowStep[] {
  return steps.flatMap((step) => {
    if (step.kind === "loop" || step.kind === "callback") return [step, ...flatten(step.body)];
    if (step.kind === "branch") return [step, ...step.paths.flatMap((path) => flatten(path.body))];
    return [step];
  });
}

describe("PythonExtractor logic flows", () => {
  it("emits structured Python flows with resolved calls, awaits, exits, and source anchors", async () => {
    const result = await extractSource([
      "def changed():",
      "    return 1",
      "",
      "async def orchestrate(flag, items):",
      "    if flag:",
      "        await changed()",
      "    else:",
      "        for item in items:",
      "            print(item)",
      "    try:",
      "        changed()",
      "    except ValueError:",
      "        raise",
      "    sorted(items, key=lambda item: changed())",
      "    return changed()",
      "",
      "changed()",
      "",
    ].join("\n"));

    const flows = result.flows ?? {};
    const orchestrate = flows["py:service#orchestrate"];
    const moduleFlow = flows["py:service"];
    expect(orchestrate).toBeDefined();
    expect(moduleFlow).toBeDefined();
    expect(orchestrate[0]).toMatchObject({ kind: "branch", branchKind: "if", label: "if flag" });
    expect(orchestrate).toContainEqual(expect.objectContaining({ kind: "branch", branchKind: "try" }));

    const steps = flatten(orchestrate);
    expect(steps).toContainEqual(expect.objectContaining({
      kind: "call",
      label: "changed",
      target: "py:service#changed",
      resolution: "resolved",
      awaited: true,
      source: { file: "service.py", line: 6, col: 14, endLine: 6, endCol: 23 },
    }));
    expect(steps).toContainEqual(expect.objectContaining({
      kind: "call",
      label: "print",
      target: "ext:python/builtins#print",
      resolution: "external",
    }));
    expect(steps).toContainEqual(expect.objectContaining({ kind: "exit", variant: "throw" }));
    expect(steps).toContainEqual(expect.objectContaining({
      kind: "callback",
      label: "callback → sorted",
      body: [expect.objectContaining({ kind: "call", target: "py:service#changed" })],
    }));
    expect(steps.at(-1)).toMatchObject({ kind: "exit", variant: "return", label: "changed()" });
    expect(moduleFlow).toContainEqual(expect.objectContaining({
      kind: "call",
      target: "py:service#changed",
      resolution: "resolved",
    }));
  });

  it("lets the language-neutral affected-flow predicate find Python callers", async () => {
    const result = await extractSource([
      "def changed():",
      "    return 1",
      "",
      "def caller():",
      "    return changed()",
      "",
    ].join("\n"));

    const affected = computeAffectedFlows(
      result.nodes,
      result.flows ?? {},
      [{ path: "service.py", status: "modified", hunks: [{ start: 1, end: 1 }] }],
    );

    expect(affected).toContainEqual(expect.objectContaining({
      flowId: "py:service#caller",
      ownerChanged: false,
      changedFilesHit: ["service.py"],
    }));
  });
});
