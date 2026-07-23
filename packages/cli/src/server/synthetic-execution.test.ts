import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, mkdirSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import type { FlowStep, GraphArtifact, LogicFlows } from "@meridian/core";
import { extractToArtifact } from "../extract-pipeline";
import {
  loadSyntheticScenarios,
  runSyntheticScenario,
  syntheticExecutionRuntimeSupported,
  syntheticSandboxCompilationRuntimeSupported,
  syntheticSourceFiles,
  syntheticSourceFingerprint,
  syntheticSourceFingerprintForFiles,
  SyntheticExecutionError,
} from "./synthetic-execution";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
const ORDERS = join(REPO, "examples", "orders-service");
const SHOPFRONT = join(REPO, "examples", "shopfront");
const temporaryRoots: string[] = [];

afterEach(() => {
  while (temporaryRoots.length > 0) rmSync(temporaryRoots.pop()!, { recursive: true, force: true });
});

describe("synthetic execution manifest", () => {
  it("reports whether the runtime can enforce both filesystem and network isolation", () => {
    expect(syntheticExecutionRuntimeSupported()).toBe(process.allowedNodeEnvironmentFlags.has("--allow-net")
      && (process.allowedNodeEnvironmentFlags.has("--permission")
        || process.allowedNodeEnvironmentFlags.has("--experimental-permission")));
  });

  it("returns capability absence for a missing manifest and safe descriptors for a configured source", () => {
    const empty = temporaryRoot();
    expect(loadSyntheticScenarios(empty)).toEqual([]);
    expect(loadSyntheticScenarios(ORDERS)).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: "place-order-happy",
        rootId: "ts:src/services/orderService.ts#OrderService.placeOrder",
      }),
    ]));
    expect(loadSyntheticScenarios(ORDERS)[0]).not.toHaveProperty("invoke");
  });

  it("rejects malformed configuration without exposing parser or filesystem details", () => {
    const root = temporaryRoot();
    writeFileSync(join(root, "meridian.synthetic.json"), "{ definitely not JSON", "utf8");
    expect(() => loadSyntheticScenarios(root)).toThrowError(SyntheticExecutionError);
    try {
      loadSyntheticScenarios(root);
    } catch (error) {
      expect(error).toMatchObject({ code: "invalid-manifest", status: 400 });
      expect((error as Error).message).toBe("Synthetic execution manifest could not be read.");
      expect((error as Error).message).not.toContain(root);
    }
  });

  it("fingerprints raw configuration and unique artifact source files deterministically", () => {
    const root = temporaryRoot();
    writeProject(root, "export function root(input: string): string { return input; }\n");
    writeManifest(root, { module: "src/index.ts", export: "root" }, "fingerprinted");
    const artifact = artifactFor("ts:src/index.ts#root", 1);
    artifact.nodes.push({ ...artifact.nodes[0]!, id: "ts:src/index.ts#root~1" });
    const first = syntheticSourceFingerprint(root, artifact);
    expect(syntheticSourceFingerprint(root, artifact)).toBe(first);
    expect(syntheticSourceFingerprintForFiles(root, syntheticSourceFiles(artifact))).toBe(first);

    writeFileSync(join(root, "package.json"), "{\"type\":\"module\"}\n", "utf8");
    const withPackage = syntheticSourceFingerprint(root, artifact);
    expect(withPackage).not.toBe(first);
    writeFileSync(join(root, "src", "index.ts"), "export function root(input: string): string { return input + '!'; }\n", "utf8");
    expect(syntheticSourceFingerprint(root, artifact)).not.toBe(withPackage);
  });

  it("rejects artifact source symlinks that escape the canonical source root", () => {
    const root = temporaryRoot();
    const outside = temporaryRoot();
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(join(outside, "index.ts"), "export function root(): void {}\n", "utf8");
    symlinkSync(join(outside, "index.ts"), join(root, "src", "index.ts"));
    writeManifest(root, { module: "src/index.ts", export: "root" }, "escaped");
    expect(() => syntheticSourceFingerprint(root, artifactFor("ts:src/index.ts#root", 1)))
      .toThrowError(SyntheticExecutionError);
  });

  it("discovers bounded nested manifests and rebases their graph and module paths", () => {
    const root = temporaryRoot();
    const nested = join(root, "examples", "demo");
    mkdirSync(join(nested, "src"), { recursive: true });
    writeFileSync(join(nested, "src", "index.ts"), "export function root(input: string): string { return input; }\n", "utf8");
    writeFileSync(join(nested, "meridian.synthetic.json"), JSON.stringify({
      manifestVersion: "1.0.0",
      scenarios: [{
        id: "nested",
        label: "nested",
        rootId: "ts:src/index.ts#root",
        defaultInput: "hello",
        invoke: { module: "src/index.ts", export: "root" },
      }],
    }), "utf8");
    expect(loadSyntheticScenarios(root)).toEqual([expect.objectContaining({
      id: "nested",
      rootId: "ts:examples/demo/src/index.ts#root",
    })]);
    const artifact = artifactFor("ts:examples/demo/src/index.ts#root", 1);
    artifact.nodes[0]!.location.file = "examples/demo/src/index.ts";
    expect(syntheticSourceFingerprint(root, artifact)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("uses the nearest nested TypeScript configuration when executing a rebased scenario", async () => {
    const root = temporaryRoot();
    const nested = join(root, "examples", "demo");
    mkdirSync(join(nested, "src"), { recursive: true });
    writeFileSync(join(nested, "tsconfig.json"), JSON.stringify({
      compilerOptions: { target: "ES2022", module: "ESNext", jsx: "react" },
      include: ["src/**/*.tsx"],
    }), "utf8");
    writeFileSync(join(nested, "src", "index.tsx"), [
      "function Unused(): unknown { return <div />; }",
      "export function root(input: string): string { return input; }",
    ].join("\n"), "utf8");
    writeFileSync(join(nested, "meridian.synthetic.json"), JSON.stringify({
      manifestVersion: "1.0.0",
      scenarios: [{
        id: "nested-tsconfig",
        label: "nested tsconfig",
        rootId: "ts:src/index.tsx#root",
        defaultInput: "configured",
        invoke: { module: "src/index.tsx", export: "root" },
      }],
    }), "utf8");
    const artifact = artifactFor("ts:examples/demo/src/index.tsx#root", 2);
    artifact.nodes[0]!.location.file = "examples/demo/src/index.tsx";

    const result = await runSyntheticScenario({
      sourceRoot: root,
      artifact,
      scenarioId: "nested-tsconfig",
    });

    expect(result.output).toBe("configured");
  }, 20_000);
});

describe("isolated TypeScript synthetic runner", () => {
  it("aborts a running runner and removes its temp root only after the child exits", async () => {
    const root = temporaryRoot();
    writeProject(root, "export function root(): never { while (true) {} }\n");
    writeManifest(root, { module: "src/index.ts", export: "root" }, "abort-runner");
    const isolatedTmp = join(root, "synthetic-tmp");
    mkdirSync(isolatedTmp);
    const originalTmp = process.env.TMPDIR;
    process.env.TMPDIR = isolatedTmp;
    const controller = new AbortController();
    const reason = new Error("synthetic service is shutting down");
    reason.name = "AbortError";
    const timer = setTimeout(() => controller.abort(reason), 50);
    try {
      await expect(runSyntheticScenario({
        sourceRoot: root,
        artifact: artifactFor("ts:src/index.ts#root", 1),
        scenarioId: "abort-runner",
        signal: controller.signal,
      })).rejects.toBe(reason);
      expect(readdirSync(isolatedTmp)).toEqual([]);
    } finally {
      clearTimeout(timer);
      if (originalTmp === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = originalTmp;
    }
  }, 20_000);

  it("aborts sandboxed compilation and cleans its temp root after the compiler child exits", async () => {
    if (!syntheticSandboxCompilationRuntimeSupported()) return;
    const root = temporaryRoot();
    writeProject(root, "export function root(input: string): string { return input.toUpperCase(); }\n");
    writeManifest(root, { module: "src/index.ts", export: "root" }, "abort-compiler");
    const isolatedTmp = join(root, "synthetic-tmp");
    mkdirSync(isolatedTmp);
    const originalTmp = process.env.TMPDIR;
    process.env.TMPDIR = isolatedTmp;
    const controller = new AbortController();
    const reason = new Error("synthetic compilation is shutting down");
    reason.name = "AbortError";
    const timer = setTimeout(() => controller.abort(reason), 0);
    try {
      await expect(runSyntheticScenario({
        sourceRoot: root,
        artifact: artifactFor("ts:src/index.ts#root", 1),
        scenarioId: "abort-compiler",
        compilationMode: "sandboxed-child",
        signal: controller.signal,
      })).rejects.toBe(reason);
      expect(readdirSync(isolatedTmp)).toEqual([]);
    } finally {
      clearTimeout(timer);
      if (originalTmp === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = originalTmp;
    }
  }, 20_000);

  it("can compile in a separate permission-gated child when the packaged worker is present", async () => {
    if (!syntheticSandboxCompilationRuntimeSupported()) return;
    const root = temporaryRoot();
    writeProject(root, "export function root(input: string): string { return input.toUpperCase(); }\n");
    writeManifest(root, { module: "src/index.ts", export: "root" }, "compiler-child");
    const result = await runSyntheticScenario({
      sourceRoot: root,
      artifact: artifactFor("ts:src/index.ts#root", 1),
      scenarioId: "compiler-child",
      input: "separate",
      compilationMode: "sandboxed-child",
    });
    expect(result.output).toBe("SEPARATE");
  }, 20_000);

  it("rebinds the exact selected occurrence input before executing its callable", async () => {
    const root = temporaryRoot();
    writeProject(root, [
      "export function child(value: number): number { return value * 2; }",
      "export function root(input: { value: number }): { before: number; child: number } {",
      "  return { before: input.value, child: child(input.value) };",
      "}",
    ].join("\n"));
    writeManifest(root, { module: "src/index.ts", export: "root" }, "override-child");
    const artifact = await extractedArtifact(root);
    const baseline = await runSyntheticScenario({
      sourceRoot: root,
      artifact,
      scenarioId: "override-child",
      input: { value: 2 },
    });
    const child = baseline.snapshots.find((snapshot) => snapshot.nodeId === "ts:src/index.ts#child")!;

    const edited = await runSyntheticScenario({
      sourceRoot: root,
      artifact,
      scenarioId: "override-child",
      input: { value: 2 },
      inputOverrides: [{
        id: "edit-child",
        target: { nodeId: child.nodeId, occurrenceKey: child.occurrenceKey },
        input: { value: 5 },
      }],
    });

    expect(edited.output).toEqual({ before: 2, child: 10 });
    expect(edited.inputOverrideResults).toEqual([expect.objectContaining({ id: "edit-child", status: "applied" })]);
    expect(edited.snapshots.find((snapshot) => snapshot.nodeId === child.nodeId)).toMatchObject({
      occurrenceKey: child.occurrenceKey,
      input: { value: 5 },
      originalInput: { value: 2 },
      inputOverrideId: "edit-child",
      output: 10,
    });
  }, 20_000);

  it("keeps an override attached to its call site when an earlier branch adds the same callee", async () => {
    const root = temporaryRoot();
    writeProject(root, [
      "export function child(value: number): number { return value * 2; }",
      "export function root(input: { includeFirst: boolean; value: number }): number[] {",
      "  const results: number[] = [];",
      "  if (input.includeFirst) results.push(child(10));",
      "  results.push(child(input.value));",
      "  return results;",
      "}",
    ].join("\n"));
    writeManifest(root, { module: "src/index.ts", export: "root" }, "call-site-override");
    const artifact = await extractedArtifact(root);
    const baseline = await runSyntheticScenario({
      sourceRoot: root,
      artifact,
      scenarioId: "call-site-override",
      input: { includeFirst: false, value: 2 },
    });
    const selected = baseline.snapshots.find((snapshot) => snapshot.nodeId === "ts:src/index.ts#child")!;

    const edited = await runSyntheticScenario({
      sourceRoot: root,
      artifact,
      scenarioId: "call-site-override",
      input: { includeFirst: true, value: 2 },
      inputOverrides: [{
        id: "keep-second-call-site",
        target: { nodeId: selected.nodeId, occurrenceKey: selected.occurrenceKey },
        input: { value: 5 },
      }],
    });

    expect(edited.output).toEqual([20, 10]);
    expect(edited.inputOverrideResults).toEqual([
      expect.objectContaining({ id: "keep-second-call-site", status: "applied" }),
    ]);
  }, 20_000);

  it("reports a root occurrence override as the effective whole-flow input", async () => {
    const root = temporaryRoot();
    writeProject(root, "export function root(input: { value: number }): number { return input.value; }\n");
    writeManifest(root, { module: "src/index.ts", export: "root" }, "root-override");
    const artifact = await extractedArtifact(root);
    const edited = await runSyntheticScenario({
      sourceRoot: root,
      artifact,
      scenarioId: "root-override",
      input: { value: 2 },
      inputOverrides: [{
        id: "edit-root",
        target: { nodeId: "ts:src/index.ts#root", occurrenceKey: "r" },
        input: { input: { value: 9 } },
      }],
    });
    expect(edited.input).toEqual({ value: 9 });
    expect(edited.output).toBe(9);
  }, 20_000);

  it("reports destructured occurrence inputs as unsupported instead of silently ignoring an edit", async () => {
    const root = temporaryRoot();
    writeProject(root, [
      "export function child({ value }: { value: number }): number { return value * 2; }",
      "export function root(input: { value: number }): number { return child(input); }",
    ].join("\n"));
    writeManifest(root, { module: "src/index.ts", export: "root" }, "unsupported-override");
    const artifact = await extractedArtifact(root);
    const baseline = await runSyntheticScenario({ sourceRoot: root, artifact, scenarioId: "unsupported-override", input: { value: 2 } });
    const child = baseline.snapshots.find((snapshot) => snapshot.nodeId === "ts:src/index.ts#child")!;
    const edited = await runSyntheticScenario({
      sourceRoot: root,
      artifact,
      scenarioId: "unsupported-override",
      input: { value: 2 },
      inputOverrides: [{
        id: "edit-child",
        target: { nodeId: child.nodeId, occurrenceKey: child.occurrenceKey },
        input: { arg0: { value: 5 } },
      }],
    });
    expect(edited.output).toBe(4);
    expect(edited.inputOverrideResults).toEqual([expect.objectContaining({
      id: "edit-child",
      status: "unsupported",
      message: expect.stringContaining("cannot be rebound"),
    })]);
  }, 20_000);

  it("stops an awaited execution at an output watcher without letting application catch handle it", async () => {
    const root = temporaryRoot();
    writeProject(root, [
      "export async function child(value: number): Promise<number> { return value * 2; }",
      "export async function root(input: { value: number }): Promise<number> {",
      "  try { return await child(input.value); } catch { return -1; }",
      "}",
    ].join("\n"));
    writeManifest(root, { module: "src/index.ts", export: "root" }, "watch-child");
    const artifact = await extractedArtifact(root);
    const stopped = await runSyntheticScenario({
      sourceRoot: root,
      artifact,
      scenarioId: "watch-child",
      input: { value: 2 },
      watchers: [{
        id: "watch-four",
        nodeId: "ts:src/index.ts#child",
        phase: "output",
        path: [],
        operator: "equals",
        expected: 4,
      }],
    });
    expect(stopped.outcome).toBe("stopped");
    expect(stopped.output).toBeUndefined();
    expect(stopped.stop?.watchHitId).toBe(stopped.watchHits[0]?.id);
    expect(stopped.watchHits[0]).toMatchObject({
      watcherId: "watch-four",
      nodeId: "ts:src/index.ts#child",
      phase: "output",
      present: true,
      value: 4,
    });
    expect(stopped.trace.status).toBe("unset");
    expect(stopped.trace.completeness.complete).toBe(false);
    expect(stopped.snapshots.some((snapshot) => snapshot.error?.includes("SyntheticWatchStop"))).toBe(false);
  }, 20_000);

  it("stops authoritatively before a Promise rejection handler can swallow the watcher signal", async () => {
    const root = temporaryRoot();
    writeProject(root, [
      "export async function child(value: number): Promise<number> { return value * 2; }",
      "export async function root(input: { value: number }): Promise<number> {",
      "  return child(input.value).catch(() => 99);",
      "}",
    ].join("\n"));
    writeManifest(root, { module: "src/index.ts", export: "root" }, "watch-promise-catch");
    const artifact = await extractedArtifact(root);
    const stopped = await runSyntheticScenario({
      sourceRoot: root,
      artifact,
      scenarioId: "watch-promise-catch",
      input: { value: 2 },
      watchers: [{
        id: "watch-four",
        nodeId: "ts:src/index.ts#child",
        phase: "output",
        path: [],
        operator: "equals",
        expected: 4,
      }],
    });
    expect(stopped.outcome).toBe("stopped");
    expect(stopped.output).toBeUndefined();
    expect(stopped.watchHits).toHaveLength(1);
  }, 20_000);

  it("stops a changes watcher on the second matching boundary occurrence", async () => {
    const root = temporaryRoot();
    writeProject(root, [
      "export function child(value: number): number { return value; }",
      "export function root(): number { child(1); child(2); return 3; }",
    ].join("\n"));
    writeManifest(root, { module: "src/index.ts", export: "root" }, "watch-changes");
    const artifact = await extractedArtifact(root);
    const stopped = await runSyntheticScenario({
      sourceRoot: root,
      artifact,
      scenarioId: "watch-changes",
      watchers: [{
        id: "watch-change",
        nodeId: "ts:src/index.ts#child",
        phase: "input",
        path: ["value"],
        operator: "changes",
      }],
    });
    expect(stopped.outcome).toBe("stopped");
    expect(stopped.watchHits[0]).toMatchObject({
      watcherId: "watch-change",
      value: 2,
      previousPresent: true,
      previousValue: 1,
    });
    expect(stopped.snapshots.filter((snapshot) => snapshot.nodeId === "ts:src/index.ts#child")).toHaveLength(2);
  }, 20_000);

  it("emits stable branch and loop evidence when edited root input changes the executed path", async () => {
    const root = temporaryRoot();
    writeProject(root, [
      "export function root(input: { enabled: boolean; items: number[] }): string {",
      "  let checks = 0;",
      "  if ((checks += 1) > 0 && input.enabled) {",
      "    let total = 0;",
      "    for (const item of input.items) {",
      "      total += item;",
      "    }",
      "    return `on:${checks}:${total}`;",
      "  }",
      "  return `off:${checks}`;",
      "}",
    ].join("\n"));
    writeManifest(root, { module: "src/index.ts", export: "root" }, "control-evidence");
    const artifact = (await extractToArtifact({
      absoluteRoot: root,
      cwd: root,
      project: join(root, "tsconfig.json"),
      materializeBoundary: true,
    })).artifact;
    const flow = (artifact.extensions?.logicFlow as LogicFlows | undefined)?.["ts:src/index.ts#root"] ?? [];
    const staticBranch = flow.find((step) => step.kind === "branch");
    const staticLoop = staticBranch?.kind === "branch"
      ? staticBranch.paths.flatMap((path) => path.body).find((step) => step.kind === "loop")
      : undefined;

    const enabled = await runSyntheticScenario({
      sourceRoot: root,
      artifact,
      scenarioId: "control-evidence",
      input: { enabled: true, items: [2, 3, 5] },
    });
    const disabled = await runSyntheticScenario({
      sourceRoot: root,
      artifact,
      scenarioId: "control-evidence",
      input: { enabled: false, items: [2, 3, 5] },
    });

    expect(enabled.output).toBe("on:1:10");
    expect(disabled.output).toBe("off:1");
    const enabledEvents = enabled.trace.spans[0]!.events;
    const disabledEvents = disabled.trace.spans[0]!.events;
    const enabledBranch = enabledEvents.find((event) => event.type === "branch.taken");
    const disabledBranch = disabledEvents.find((event) => event.type === "branch.taken");
    expect(enabledBranch).toMatchObject({
      type: "branch.taken",
      pathId: "then",
      outcome: true,
      condition: "(checks += 1) > 0 && input.enabled",
      source: { file: "src/index.ts", line: 3, col: 2 },
    });
    expect(disabledBranch).toMatchObject({
      type: "branch.taken",
      pathId: "else",
      outcome: false,
      source: { file: "src/index.ts", line: 3, col: 2 },
    });
    expect(disabledBranch?.siteId).toBe(enabledBranch?.siteId);
    expect(staticBranch?.source).toBeDefined();
    expect(enabledBranch?.source.line).toBe(staticBranch?.source?.line);
    expect(normalizedSourceFile(enabledBranch?.source.file)).toBe(normalizedSourceFile(staticBranch?.source?.file));
    if (staticBranch?.source?.col !== undefined) {
      expect(enabledBranch?.source.col).toBe(staticBranch.source.col);
    }
    const enabledLoop = enabledEvents.find((event) => event.type === "loop.summary");
    expect(enabledLoop).toMatchObject({
      type: "loop.summary",
      iterations: 3,
      emittedIterations: 3,
      truncated: false,
      source: { file: "src/index.ts", line: 5, col: 4 },
    });
    const staticLoopSource = (staticLoop as Extract<FlowStep, { kind: "loop" }> | undefined)?.source;
    expect(staticLoopSource).toBeDefined();
    expect(enabledLoop?.source.line).toBe(staticLoopSource?.line);
    expect(normalizedSourceFile(enabledLoop?.source.file)).toBe(normalizedSourceFile(staticLoopSource?.file));
    if (staticLoopSource?.col !== undefined) expect(enabledLoop?.source.col).toBe(staticLoopSource.col);
    expect(disabledEvents.some((event) => event.type === "loop.summary")).toBe(false);
    expect(enabled.trace.completeness).toMatchObject({ complete: true, droppedEvents: 0 });
    expect(disabled.trace.completeness).toMatchObject({ complete: true, droppedEvents: 0 });
  }, 40_000);

  it("bounds high-volume branch evidence instead of returning an invalid trace", async () => {
    const root = temporaryRoot();
    writeProject(root, [
      "export function root(iterations: number): number {",
      "  let observed = 0;",
      "  for (let index = 0; index < iterations; index += 1) {",
      "    if (index >= 0) observed += 1;",
      "  }",
      "  return observed;",
      "}",
    ].join("\n"));
    writeManifest(root, { module: "src/index.ts", export: "root" }, "bounded-events");

    const result = await runSyntheticScenario({
      sourceRoot: root,
      artifact: artifactFor("ts:src/index.ts#root", 1),
      scenarioId: "bounded-events",
      input: 2_005,
    });

    expect(result.output).toBe(2_005);
    expect(result.trace.spans[0]!.events).toHaveLength(2_000);
    expect(result.trace.completeness.complete).toBe(false);
    expect(result.trace.completeness.droppedEvents).toBeGreaterThan(0);
    expect(result.warnings.join(" ")).toMatch(/control events were truncated/i);
  }, 20_000);

  it("executes the real place-order flow and captures occurrence-specific input/output snapshots", async () => {
    const projectFile = join(ORDERS, "src", "services", "orderService.ts");
    const before = readFileSync(projectFile, "utf8");
    const artifact = await ordersArtifact();
    const result = await runSyntheticScenario({ sourceRoot: ORDERS, artifact, scenarioId: "place-order-happy" });

    expect(result.output).toMatchObject({
      id: "ord_1",
      subtotalCents: 2_100,
      discountCents: 210,
      taxCents: 378,
      totalCents: 2_268,
    });
    expect(result.trace.status).toBe("ok");
    expect(result.trace.spans.map((span) => span.nodeId)).toEqual(expect.arrayContaining([
      "ts:src/services/orderService.ts#OrderService.placeOrder",
      "ts:src/validation/orderValidator.ts#validateOrderRequest",
      "ts:src/pricing/pricingService.ts#PricingService.price",
      "ts:src/services/orderService.ts#OrderService.assemble",
      "ts:src/repository/orderRepository.ts#OrderRepository.save",
    ]));
    const pricing = result.snapshots.find((snapshot) => snapshot.nodeId.endsWith("#PricingService.price"));
    expect(pricing).toMatchObject({
      input: { request: expect.objectContaining({ discountCode: "WELCOME10" }) },
      output: { subtotalCents: 2_100, discountCents: 210, taxCents: 378, totalCents: 2_268 },
    });
    const validation = result.trace.spans.find((span) => span.nodeId?.endsWith("#validateOrderRequest"));
    expect(validation?.events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: "branch.taken",
        pathId: "else",
        source: { file: "src/validation/orderValidator.ts", line: 8, col: 2 },
      }),
      expect.objectContaining({
        type: "branch.taken",
        pathId: "else",
        source: { file: "src/validation/orderValidator.ts", line: 11, col: 2 },
      }),
      expect.objectContaining({
        type: "loop.summary",
        iterations: 2,
        source: { file: "src/validation/orderValidator.ts", line: 14, col: 2 },
      }),
    ]));
    expect(result.snapshots.filter((snapshot) => snapshot.nodeId.endsWith("#assertLineIsSane"))).toHaveLength(2);
    expect(readFileSync(projectFile, "utf8")).toBe(before);
  }, 20_000);

  it("executes the PR-review shopfront add-item adapter from one editable JSON input", async () => {
    const artifact = await extractedArtifact(SHOPFRONT);
    const result = await runSyntheticScenario({
      sourceRoot: SHOPFRONT,
      artifact,
      scenarioId: "shopfront-add-item-unavailable",
    });

    expect(result.output).toMatchObject({
      status: 200,
      body: { id: "synthetic_cart", items: [] },
    });
    expect(result.trace.status).toBe("ok");
    expect(result.trace.spans.map((span) => span.nodeId)).toEqual(expect.arrayContaining([
      "ts:src/api/cartRoutes.ts#CartRoutes.handleAddItem",
      "ts:src/services/cartService.ts#CartService.addItem",
      "ts:src/services/catalogService.ts#CatalogService.getProduct",
    ]));
    expect(result.snapshots.find((snapshot) => (
      snapshot.nodeId === "ts:src/api/cartRoutes.ts#CartRoutes.handleAddItem"
    ))).toMatchObject({
      input: {
        cartId: "synthetic_cart",
        productId: "coffee-beans",
        quantity: 2,
      },
    });
  }, 20_000);

  it("turns a real handled exception into failed child snapshots while preserving the root output", async () => {
    const artifact = await ordersArtifact();
    const result = await runSyntheticScenario({
      sourceRoot: ORDERS,
      artifact,
      scenarioId: "create-order-validation-error",
    });
    expect(result.trace.status).toBe("ok");
    expect(result.output).toEqual({ status: 400, body: { error: "order is missing a customer" } });
    expect(result.snapshots).toEqual(expect.arrayContaining([
      expect.objectContaining({
        nodeId: "ts:src/validation/orderValidator.ts#validateOrderRequest",
        error: expect.stringContaining("order is missing a customer"),
      }),
    ]));
  }, 20_000);

  it("denies filesystem reads in the plain Node child instead of silently running unrestricted", async () => {
    const root = temporaryRoot();
    writeProject(root, `import { readFileSync } from "node:fs";\nexport function root(input: string): string { return readFileSync("/etc/passwd", "utf8") + input; }\n`);
    writeManifest(root, { module: "src/index.ts", export: "root" }, "blocked-read");
    const result = await runSyntheticScenario({
      sourceRoot: root,
      artifact: artifactFor("ts:src/index.ts#root", 2),
      scenarioId: "blocked-read",
    });
    expect(result.trace.status).toBe("error");
    expect(result.snapshots[0]?.error).toMatch(/restricted|permission|access/i);
    expect(result.output).toBeUndefined();
  }, 20_000);

  it("denies network access before target code can reach a real localhost listener", async () => {
    const root = temporaryRoot();
    writeProject(root, "export async function root(input: string): Promise<number> { return (await fetch(input)).status; }\n");
    writeManifest(root, { module: "src/index.ts", export: "root" }, "blocked-network");
    let hits = 0;
    const server = createServer((_request, response) => {
      hits += 1;
      response.writeHead(200).end("unexpected");
    });
    await new Promise<void>((resolveListen, rejectListen) => {
      server.once("error", rejectListen);
      server.listen(0, "127.0.0.1", () => resolveListen());
    });
    try {
      const port = (server.address() as AddressInfo).port;
      const result = await runSyntheticScenario({
        sourceRoot: root,
        artifact: artifactFor("ts:src/index.ts#root", 1),
        scenarioId: "blocked-network",
        input: `http://127.0.0.1:${port}/should-not-connect`,
      });
      expect(result.trace.status).toBe("error");
      expect(result.snapshots[0]?.error).toMatch(/fetch|network|permission|access/i);
      expect(hits).toBe(0);
    } finally {
      await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
    }
  }, 20_000);

  it("arms only after the configured factory completes, so factory calls cannot consume the root", async () => {
    const root = temporaryRoot();
    writeProject(root, [
      "export function root(input: string): string { return input; }",
      "export function build(): { root: typeof root } { root('factory'); return { root }; }",
    ].join("\n"));
    writeManifest(root, { module: "src/index.ts", export: "build", method: "root" }, "armed-root");
    const result = await runSyntheticScenario({
      sourceRoot: root,
      artifact: artifactFor("ts:src/index.ts#root", 1),
      scenarioId: "armed-root",
      input: "selected",
    });
    expect(result.output).toBe("selected");
    expect(result.trace.spans).toHaveLength(1);
    expect(result.snapshots[0]?.input).toEqual({ input: "selected" });
  }, 20_000);

  it("rejects an ambiguous static source join instead of instrumenting the first candidate", async () => {
    const root = temporaryRoot();
    writeProject(root, "export function root(input: string): string { return input; }\n");
    writeManifest(root, { module: "src/index.ts", export: "root" }, "ambiguous");
    const artifact = artifactFor("ts:src/index.ts#root", 1);
    artifact.nodes.push({ ...artifact.nodes[0]!, id: "ts:src/index.ts#root~1" });
    artifact.edges.push({
      id: "calls@ts:src/index.ts#root|ts:src/index.ts#root~1",
      source: "ts:src/index.ts#root",
      target: "ts:src/index.ts#root~1",
      kind: "calls",
      resolution: "resolved",
    });
    await expect(runSyntheticScenario({
      sourceRoot: root,
      artifact,
      scenarioId: "ambiguous",
    })).rejects.toMatchObject({ code: "unsupported-scenario", status: 422 });
  });

  it("marks the trace incomplete when a runtime snapshot must be truncated", async () => {
    const root = temporaryRoot();
    writeProject(root, "export function root(): number[] { return Array.from({ length: 513 }, (_, index) => index); }\n");
    writeManifest(root, { module: "src/index.ts", export: "root" }, "truncated");
    const result = await runSyntheticScenario({
      sourceRoot: root,
      artifact: artifactFor("ts:src/index.ts#root", 1),
      scenarioId: "truncated",
    });
    expect(result.trace.completeness.complete).toBe(false);
    expect(result.trace.completeness.droppedValues).toBeGreaterThan(0);
    expect(result.warnings.join(" ")).toMatch(/truncated/i);
    expect(result.output).toHaveLength(512);
  }, 20_000);

  it("fails closed for an unsupported generator root", async () => {
    const root = temporaryRoot();
    writeProject(root, "export function* root(input: string): Generator<string> { yield input; }\n");
    writeManifest(root, { module: "src/index.ts", export: "root" }, "generator");
    await expect(runSyntheticScenario({
      sourceRoot: root,
      artifact: artifactFor("ts:src/index.ts#root", 1),
      scenarioId: "generator",
    })).rejects.toMatchObject({ code: "unsupported-scenario", status: 422 });
  });

  it("rejects stale advertised source before compiling the project", async () => {
    const root = temporaryRoot();
    writeProject(root, "export function root(input: string): string { return input; }\n");
    writeManifest(root, { module: "src/index.ts", export: "root" }, "stale-source");
    const artifact = artifactFor("ts:src/index.ts#root", 1);
    const expectedSourceFingerprint = syntheticSourceFingerprint(root, artifact);
    writeFileSync(join(root, "src", "index.ts"), "this is no longer valid TypeScript {", "utf8");
    await expect(runSyntheticScenario({
      sourceRoot: root,
      artifact,
      scenarioId: "stale-source",
      expectedSourceFingerprint,
    })).rejects.toMatchObject({ code: "invalid-request", status: 409 });
  });
});

async function ordersArtifact(): Promise<GraphArtifact> {
  return (await extractToArtifact({
    absoluteRoot: ORDERS,
    cwd: ORDERS,
    project: join(ORDERS, "tsconfig.json"),
    materializeBoundary: true,
  })).artifact;
}

async function extractedArtifact(root: string): Promise<GraphArtifact> {
  return (await extractToArtifact({
    absoluteRoot: root,
    cwd: root,
    project: join(root, "tsconfig.json"),
    materializeBoundary: true,
  })).artifact;
}

function temporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "meridian-synthetic-test-"));
  temporaryRoots.push(root);
  return root;
}

function writeProject(root: string, source: string): void {
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "src", "index.ts"), source, "utf8");
  writeFileSync(join(root, "tsconfig.json"), JSON.stringify({
    compilerOptions: { target: "ES2022", module: "ESNext", moduleResolution: "Bundler", strict: true, rootDir: "src" },
    include: ["src/**/*.ts"],
  }), "utf8");
}

function writeManifest(root: string, invoke: { module: string; export: string; method?: string }, id: string): void {
  writeFileSync(join(root, "meridian.synthetic.json"), JSON.stringify({
    manifestVersion: "1.0.0",
    scenarios: [{ id, label: id, rootId: "ts:src/index.ts#root", defaultInput: "input", invoke }],
  }), "utf8");
}

function normalizedSourceFile(file: string | undefined): string {
  if (file === undefined) throw new Error("expected control-flow source file");
  return file.replaceAll("\\", "/");
}

function artifactFor(rootId: string, line: number): GraphArtifact {
  return {
    schemaVersion: "1.1.0",
    generatedAt: "2026-07-12T00:00:00.000Z",
    generator: { name: "test", version: "1" },
    target: { name: "fixture", root: ".", language: "typescript" },
    nodes: [{
      id: rootId,
      kind: "function",
      qualifiedName: "root",
      displayName: "root",
      parentId: null,
      location: { file: "src/index.ts", startLine: line, endLine: line },
    }],
    edges: [],
  };
}
