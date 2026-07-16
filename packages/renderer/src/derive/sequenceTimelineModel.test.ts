import { describe, expect, it } from "vitest";
import type { FlowStep, LogicFlows } from "@meridian/core";
import type { GraphIndex } from "../graph/graphIndex";
import { buildSequenceTimeline } from "./sequenceTimelineModel";

const ROOT = "ts:src/bootstrap.ts#bootstrap";
const HOST = "ts:src/host.ts#HostBinding";
const REGISTER = "ts:src/host.ts#registerHooks";
const STORE = "ts:src/store.ts#addHook";
const DEEP = "ts:src/deep.ts#write";

function index(statuses: Array<[string, "added" | "modified" | "deleted" | "renamed"]> = []): GraphIndex {
  return {
    nodesById: new Map([
      [ROOT, { id: ROOT, kind: "function", displayName: "bootstrap", location: { file: "src/bootstrap.ts", startLine: 1 } }],
      [REGISTER, { id: REGISTER, kind: "function", displayName: "registerHooks", location: { file: "src/host.ts", startLine: 1 } }],
      [STORE, { id: STORE, kind: "method", displayName: "addHook", location: { file: "src/store.ts", startLine: 1 } }],
      [DEEP, { id: DEEP, kind: "function", displayName: "write", location: { file: "src/deep.ts", startLine: 1 } }],
    ]),
    changedStatus: new Map(statuses),
  } as unknown as GraphIndex;
}

describe("buildSequenceTimeline", () => {
  it("inlines resolved callees one level and emits solid-call/dashed-return pairs", () => {
    const steps: FlowStep[] = [
      { kind: "call", label: "registerHooks()", target: REGISTER, resolution: "resolved" },
    ];
    const flows: LogicFlows = {
      [REGISTER]: [
        { kind: "call", label: "addHook()", target: STORE, resolution: "resolved" },
        { kind: "exit", variant: "return", label: "ready" },
      ],
      [STORE]: [
        { kind: "call", label: "write()", target: DEEP, resolution: "resolved" },
      ],
    };

    const model = buildSequenceTimeline(ROOT, steps, flows, index([[REGISTER, "added"]]));
    const messages = model.rows.filter((row) => row.type === "message");

    expect(model.participants.map((participant) => participant.nodeId)).toEqual([ROOT, REGISTER, STORE]);
    expect(model.participants.find((participant) => participant.nodeId === REGISTER)?.changedStatus).toBe("added");
    expect(messages.map((message) => [message.kind, message.label])).toEqual([
      ["call", "registerHooks()"],
      ["call", "addHook()"],
      ["return", "returns"],
      ["return", "returns"],
    ]);
    expect(messages.map((message) => message.visualRole)).toEqual([
      "primary",
      "primary",
      "detail",
      "detail",
    ]);
    expect(model.participants.some((participant) => participant.nodeId === DEEP)).toBe(false);
  });

  it("collapses recursive inline cycles instead of walking forever", () => {
    const flows: LogicFlows = {
      [REGISTER]: [{ kind: "call", label: "bootstrap()", target: ROOT, resolution: "resolved" }],
    };
    const model = buildSequenceTimeline(ROOT, [
      { kind: "call", label: "registerHooks()", target: REGISTER, resolution: "resolved" },
    ], flows, index());

    expect(model.rows.some((row) => row.type === "note" && row.label.includes("nested cycle collapsed"))).toBe(true);
    expect(model.rows).toHaveLength(5);
  });

  it("groups callable targets under the nearest component owner while preserving exact message targets", () => {
    const graph = index([[REGISTER, "added"]]);
    graph.nodesById.set(HOST, {
      id: HOST,
      kind: "class",
      qualifiedName: "HostBinding",
      displayName: "Host binding",
      location: { file: "src/host.ts", startLine: 1 },
    });
    const register = graph.nodesById.get(REGISTER)!;
    register.parentId = HOST;
    graph.parentOf = new Map([[ROOT, null], [HOST, null], [REGISTER, HOST]]);

    const model = buildSequenceTimeline(ROOT, [
      { kind: "call", label: "registerHooks()", target: REGISTER, resolution: "resolved" },
    ], {}, graph);
    const call = model.rows.find((row) => row.type === "message" && row.kind === "call");

    expect(model.participants.map((participant) => participant.nodeId)).toEqual([ROOT, HOST]);
    expect(call).toMatchObject({ target: REGISTER, to: `sequence:node:${HOST}` });
  });

  it("projects loops, handed-over callbacks, alternatives, waits, and exits explicitly", () => {
    const steps: FlowStep[] = [
      {
        kind: "loop",
        label: "each registered hook",
        body: [{ kind: "call", label: "registerHook()", target: REGISTER, resolution: "resolved" }],
      },
      {
        kind: "callback",
        label: "onReady",
        body: [{ kind: "await", label: "hook barrier", mode: "single", inputs: [{ label: "hooks" }] }],
      },
      { kind: "await", label: "registration barrier", mode: "single", inputs: [{ label: "hooks" }] },
      {
        kind: "branch",
        branchKind: "if",
        label: "registration result",
        paths: [
          { label: "success", role: "then", body: [{ kind: "exit", variant: "return", label: "session" }] },
          { label: "failure", role: "else", body: [{ kind: "exit", variant: "throw", label: "error" }] },
        ],
      },
    ];

    const model = buildSequenceTimeline(ROOT, steps, {}, index());

    expect(model.frames.map((frame) => frame.kind)).toEqual(["loop", "alt", "callback"]);
    expect(model.frames.find((frame) => frame.kind === "alt")?.separators).toEqual([
      expect.objectContaining({ label: "failure" }),
    ]);
    expect(model.rows.some((row) => row.type === "note" && row.tone === "wait" && row.label.includes("registration barrier"))).toBe(true);
    expect(model.frames.some((frame) => frame.kind === "callback" && frame.label.includes("timing unknown"))).toBe(true);
    expect(model.rows.some((row) => row.type === "note" && row.label.includes("hook barrier"))).toBe(true);
    expect(model.rows.filter((row) => row.type === "note" && row.tone === "exit").map((row) => row.label)).toEqual([
      "return session",
      "throw error",
    ]);
    expect(model.participants.some((participant) => participant.kind === "callback")).toBe(true);
  });

  it("charts deferred callback bodies after, but not ordered against, the parent continuation", () => {
    const model = buildSequenceTimeline(ROOT, [
      {
        kind: "callback",
        label: "onReady",
        body: [
          { kind: "call", label: "addHook()", target: STORE, resolution: "resolved" },
          { kind: "await", label: "hook barrier", mode: "single", inputs: [] },
        ],
      },
      { kind: "call", label: "registerHooks()", target: REGISTER, resolution: "resolved" },
    ], {}, index());

    const messages = model.rows.filter((row) => row.type === "message");
    const summary = model.rows.find((row) => row.type === "note" && row.tone === "handoff");
    const parentCall = messages.find((message) => message.kind === "call" && message.target === REGISTER);
    const parentReturn = messages.find((message) => message.kind === "return" && message.target === REGISTER);
    const callbackBodyCall = messages.find((message) => message.kind === "call" && message.target === STORE);

    expect(messages.map((message) => message.label)).toEqual([
      "register onReady",
      "registerHooks()",
      "returns",
      "addHook()",
      "returns",
    ]);
    expect(callbackBodyCall?.row).toBeGreaterThan(parentCall!.row);
    expect(callbackBodyCall?.row).toBeGreaterThan(parentReturn!.row);
    expect(model.rows.some((row) => row.type === "note" && row.tone === "wait" && row.label.includes("hook barrier"))).toBe(true);
    expect(summary?.label).toBe("definition only · not ordered against parent continuation");
    expect(model.frames.find((frame) => frame.kind === "callback")?.label).toBe("onReady · deferred / timing unknown");
  });

  it("queues nested callback regions after each containing callback's visible continuation", () => {
    const model = buildSequenceTimeline(ROOT, [
      {
        kind: "callback",
        label: "outer",
        body: [
          {
            kind: "callback",
            label: "nested",
            body: [{ kind: "call", label: "write()", target: DEEP, resolution: "resolved" }],
          },
          { kind: "call", label: "addHook()", target: STORE, resolution: "resolved" },
        ],
      },
      { kind: "call", label: "registerHooks()", target: REGISTER, resolution: "resolved" },
    ], {}, index());
    const messages = model.rows.filter((row) => row.type === "message");
    const outerContinuation = messages.find((message) => message.kind === "call" && message.target === STORE);
    const nestedBody = messages.find((message) => message.kind === "call" && message.target === DEEP);
    const callbackFrames = model.frames.filter((frame) => frame.kind === "callback");

    expect(callbackFrames.map((frame) => frame.label)).toEqual([
      "outer · deferred / timing unknown",
      "nested · deferred / timing unknown",
    ]);
    expect(nestedBody?.row).toBeGreaterThan(outerContinuation!.row);
    expect(callbackFrames[1]!.startRow).toBeGreaterThan(callbackFrames[0]!.endRow);
  });

  it("keeps launched async work parallel and returns its handle without inlining completion", () => {
    const flows: LogicFlows = {
      [REGISTER]: [{ kind: "call", label: "write()", target: DEEP, resolution: "resolved" }],
    };
    const model = buildSequenceTimeline(ROOT, [
      {
        kind: "call",
        label: "startRegistration()",
        target: REGISTER,
        resolution: "resolved",
        async: { kind: "launch", taskId: "registration", binding: "pendingRegistration" },
      },
      { kind: "call", label: "addHook()", target: STORE, resolution: "resolved" },
    ], flows, index(), { maxInlineDepth: 2 });
    const messages = model.rows.filter((row) => row.type === "message");

    expect(messages.map((message) => [message.kind, message.label])).toEqual([
      ["call", "startRegistration()"],
      ["return", "task handle · pendingRegistration"],
      ["call", "addHook()"],
      ["return", "returns"],
    ]);
    expect(messages.some((message) => message.target === DEEP)).toBe(false);
    expect(model.rows.some((row) => row.type === "note" && row.label === "starts in parallel · continuation keeps pendingRegistration")).toBe(true);
  });

  it("adds the implicit else or no-match alternative omitted by source syntax", () => {
    const model = buildSequenceTimeline(ROOT, [{
      kind: "branch",
      branchKind: "if",
      label: "hooks ready?",
      paths: [{
        label: "ready",
        role: "then",
        body: [{ kind: "call", label: "registerHooks()", target: REGISTER, resolution: "resolved" }],
      }],
    }], {}, index());
    const frame = model.frames.find((candidate) => candidate.kind === "alt");

    expect(frame?.separators).toEqual([
      expect.objectContaining({ label: "else (implicit)" }),
    ]);
    expect(model.rows.some((row) => row.type === "note" && row.label === "else · implicit source fallthrough")).toBe(true);
  });

  it("suppresses resolution only when every callee path throws", () => {
    const allThrow: LogicFlows = {
      [REGISTER]: [{
        kind: "branch",
        branchKind: "if",
        label: "registration outcome",
        paths: [
          { label: "invalid", role: "then", body: [{ kind: "exit", variant: "throw", label: "invalid" }] },
          { label: "failed", role: "else", body: [{ kind: "exit", variant: "throw", label: "failed" }] },
        ],
      }],
    };
    const mixed: LogicFlows = {
      [REGISTER]: [{
        kind: "branch",
        branchKind: "if",
        label: "registration outcome",
        paths: [
          { label: "failed", role: "then", body: [{ kind: "exit", variant: "throw", label: "failed" }] },
          { label: "ready", role: "else", body: [{ kind: "exit", variant: "return", label: "hooks" }] },
        ],
      }],
    };
    const call: FlowStep[] = [{
      kind: "call",
      label: "registerHooks()",
      target: REGISTER,
      resolution: "resolved",
      awaited: true,
    }];

    const throwingMessages = buildSequenceTimeline(ROOT, call, allThrow, index()).rows
      .filter((row) => row.type === "message");
    const mixedMessages = buildSequenceTimeline(ROOT, call, mixed, index()).rows
      .filter((row) => row.type === "message");

    expect(throwingMessages.map((message) => [message.kind, message.label])).toEqual([
      ["call", "await registerHooks()"],
    ]);
    expect(mixedMessages.map((message) => [message.kind, message.label])).toEqual([
      ["call", "await registerHooks()"],
      ["return", "resolves"],
    ]);
  });

  it("bounds participant fan-out and row count with deterministic guard notes", () => {
    const calls: FlowStep[] = [REGISTER, STORE, DEEP, "ts:src/four.ts#four"].map((target) => ({
      kind: "call" as const,
      label: `${target.split("#")[1]}()`,
      target,
      resolution: "resolved" as const,
    }));
    const participantBound = buildSequenceTimeline(ROOT, calls, {}, index(), { maxParticipants: 3, maxRows: 40 });
    expect(participantBound.participants).toHaveLength(3);
    expect(participantBound.participants.at(-1)?.kind).toBe("overflow");
    expect(participantBound.truncated).toBe(true);

    const manyWaits: FlowStep[] = Array.from({ length: 8 }, (_, item) => ({
      kind: "await" as const,
      label: `barrier ${item}`,
      mode: "single" as const,
      inputs: [],
    }));
    const rowBound = buildSequenceTimeline(ROOT, manyWaits, {}, index(), { maxRows: 4 });
    expect(rowBound.rows).toHaveLength(4);
    expect(rowBound.rows.at(-1)).toMatchObject({ type: "note", tone: "guard", label: "Flow truncated at 4 rows" });
    expect(buildSequenceTimeline(ROOT, manyWaits, {}, index(), { maxRows: 4 })).toEqual(rowBound);
  });
});
