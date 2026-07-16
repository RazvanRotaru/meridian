import { describe, expect, it } from "vitest";
import type { FlowStep, GraphArtifact, GraphEdge, GraphNode, LogicFlows } from "@meridian/core";
import { buildGraphIndex } from "../graph/graphIndex";
import { causalSequenceTimelineFor } from "./causalSequenceTimeline";

const ids = {
  client: "ts:client.ts#Client",
  wait: "ts:client.ts#Client.wait",
  acknowledge: "ts:client.ts#Client.acknowledge",
  ready: "promise:client.ts#Client.ready",
  bootstrap: "ts:bootstrap.ts#bootstrap",
  restore: "ts:bootstrap.ts#restore",
};

function node(
  id: string,
  kind: string,
  displayName: string,
  file: string,
  startLine: number,
  parentId: string | null = null,
): GraphNode {
  return { id, kind, qualifiedName: id, displayName, parentId, location: { file, startLine } };
}

function edge(
  id: string,
  source: string,
  target: string,
  kind: string,
  line: number,
  extras: Partial<GraphEdge> = {},
): GraphEdge {
  return {
    id,
    source,
    target,
    kind,
    resolution: "resolved",
    callSites: [{ file: source.includes("bootstrap") ? "bootstrap.ts" : "client.ts", line }],
    ...extras,
  };
}

function artifact(nodes: GraphNode[], edges: GraphEdge[], flows: LogicFlows = {}): GraphArtifact {
  return {
    schemaVersion: "1.1.0",
    generatedAt: "2026-07-15T00:00:00.000Z",
    generator: { name: "test", version: "1" },
    target: { name: "test", root: ".", language: "typescript" },
    nodes,
    edges,
    extensions: { logicFlow: flows as never },
  };
}

describe("causalSequenceTimelineFor", () => {
  it("renders one Promise identity as a compact await / resolve-or-reject lifecycle", () => {
    const nodes = [
      node(ids.client, "class", "DelegateClient", "client.ts", 1),
      node(ids.wait, "method", "waitForHookRegistration", "client.ts", 10, ids.client),
      node(ids.acknowledge, "method", "acknowledgeHookRegistration", "client.ts", 14, ids.client),
      node(ids.ready, "promise", "_hookRegistrationReady", "client.ts", 5, ids.client),
      node(ids.bootstrap, "function", "bootstrapIframe", "bootstrap.ts", 1),
      node(ids.restore, "function", "restoreInitialSession", "bootstrap.ts", 25),
    ];
    const edges = [
      edge("create", ids.client, ids.ready, "createsPromise", 5),
      edge("return", ids.wait, ids.ready, "returnsPromise", 11),
      edge("await", ids.bootstrap, ids.ready, "awaitsPromise", 20),
      edge("resolve", ids.acknowledge, ids.ready, "resolvesPromise", 17),
      edge("reject", ids.acknowledge, ids.ready, "rejectsPromise", 15),
      edge("call-wait", ids.bootstrap, ids.wait, "calls", 20),
      edge("call-restore", ids.bootstrap, ids.restore, "calls", 25),
    ];
    const waitCall: FlowStep = {
      kind: "call",
      label: "client.waitForHookRegistration",
      target: ids.wait,
      resolution: "resolved",
      awaited: true,
      source: { file: "bootstrap.ts", line: 20 },
    };
    const restoreCall: FlowStep = {
      kind: "call",
      label: "restoreInitialSession",
      target: ids.restore,
      resolution: "resolved",
      detached: true,
      async: { kind: "launch", taskId: "task:restore" },
      source: { file: "bootstrap.ts", line: 25 },
    };
    const graph = artifact(nodes, edges, { [ids.bootstrap]: [waitCall, restoreCall] });
    const model = causalSequenceTimelineFor(graph, ids.wait, buildGraphIndex(graph));

    expect(model).not.toBeNull();
    expect(model!.participants.map((participant) => participant.label)).toEqual([
      "bootstrapIframe",
      "DelegateClient",
      "restoreInitialSession",
      "_hookRegistrationReady",
    ]);
    expect(model!.participants.at(-1)?.kind).toBe("resource");
    expect(model!.rows.map((row) => row.label)).toEqual([
      "creates _hookRegistrationReady",
      "_hookRegistrationReady · pending",
      "await waitForHookRegistration()",
      "blocked on _hookRegistrationReady",
      "acknowledgeHookRegistration()",
      "wait completes",
      "restoreInitialSession()",
      "acknowledgeHookRegistration(error)",
      "wait rejects",
    ]);
    expect(model!.frames).toEqual([
      expect.objectContaining({ kind: "alt", label: "Promise resolves", separators: [{ row: 7, label: "Promise rejects" }] }),
    ]);
    expect(model!.rows.find((row) => row.label === "restoreInitialSession()")).toMatchObject({
      type: "message",
      tone: "detached",
    });

    const fromSettlement = causalSequenceTimelineFor(graph, ids.acknowledge, buildGraphIndex(graph));
    expect(fromSettlement).toEqual(model);
  });

  it("renders the call/IPC trigger corridor and real post-wait consequences around one Promise", () => {
    const trigger = node("ts:host.ts#onReady", "function", "onReady", "host.ts", 1);
    const sender = node("ts:host.ts#sendRegistration", "function", "sendRegistration", "host.ts", 5);
    const channel = node(
      "ipc:postmessage/lane=window-message/channel=type%3Aregistration",
      "channel",
      "type:registration",
      "(postmessage)",
      1,
    );
    const handler = node("ts:client.ts#handleRegistration", "function", "handleRegistration", "client.ts", 7);
    const installer = node("ts:client.ts#installHandler", "function", "installHandler", "client.ts", 3);
    const nodes = [
      node(ids.client, "class", "DelegateClient", "client.ts", 1),
      node(ids.wait, "method", "waitForHookRegistration", "client.ts", 10, ids.client),
      node(ids.acknowledge, "method", "acknowledgeHookRegistration", "client.ts", 14, ids.client),
      node(ids.ready, "promise", "_hookRegistrationReady", "client.ts", 5, ids.client),
      node(ids.bootstrap, "function", "bootstrapIframe", "bootstrap.ts", 1),
      node(ids.restore, "function", "restoreInitialSession", "bootstrap.ts", 25),
      trigger,
      sender,
      channel,
      handler,
      installer,
    ];
    const edges = [
      edge("return", ids.wait, ids.ready, "returnsPromise", 11),
      edge("await", ids.bootstrap, ids.ready, "awaitsPromise", 20),
      edge("resolve", ids.acknowledge, ids.ready, "resolvesPromise", 17),
      edge("reject", ids.acknowledge, ids.ready, "rejectsPromise", 15),
      edge("call-wait", ids.bootstrap, ids.wait, "calls", 20),
      edge("call-restore", ids.bootstrap, ids.restore, "calls", 25),
      edge("trigger", trigger.id, sender.id, "calls", 2),
      edge("send", sender.id, channel.id, "sends", 6, { resolution: "unresolved", confidence: 0.65 }),
      edge("handle", channel.id, handler.id, "handles", 8, { resolution: "unresolved", confidence: 0.65 }),
      // Static callers of a delivered handler represent setup/tests, not a competing runtime
      // trigger; the channel delivery must win when both are present.
      edge("install-handler", installer.id, handler.id, "calls", 4),
      edge("dispatch", handler.id, ids.acknowledge, "calls", 9),
    ];
    const waitCall: FlowStep = {
      kind: "call",
      label: "client.waitForHookRegistration",
      target: ids.wait,
      resolution: "resolved",
      awaited: true,
      source: { file: "bootstrap.ts", line: 20 },
    };
    const restoreCall: FlowStep = {
      kind: "call",
      label: "restoreInitialSession",
      target: ids.restore,
      resolution: "resolved",
      detached: true,
      async: { kind: "launch", taskId: "task:restore" },
      source: { file: "bootstrap.ts", line: 25 },
    };
    const graph = artifact(nodes, edges, { [ids.bootstrap]: [waitCall, restoreCall] });

    const model = causalSequenceTimelineFor(graph, ids.wait, buildGraphIndex(graph));

    expect(model?.rows.map((row) => row.label)).toEqual([
      "await waitForHookRegistration()",
      "blocked on _hookRegistrationReady",
      "sendRegistration()",
      "send · type:registration",
      "deliver · type:registration",
      "acknowledgeHookRegistration()",
      "acknowledgeHookRegistration()",
      "wait completes",
      "restoreInitialSession()",
      "acknowledgeHookRegistration(error)",
      "wait rejects",
    ]);
    expect(model?.rows.map((row) => row.label)).not.toContain("continues after wait");
    expect(model?.rows.map((row) => row.label)).not.toContain("handleRegistration()");
    expect(model?.participants.map((participant) => participant.label)).not.toContain("installHandler");
    expect(model?.frames).toEqual([
      expect.objectContaining({
        kind: "alt",
        label: "Promise resolves",
        startRow: 6,
        endRow: 10,
        separators: [{ row: 9, label: "Promise rejects" }],
      }),
    ]);
    expect(model?.truncated).toBe(false);
  });

  it("renders an ordered predecessor call tree before an upstream RPC and excludes other control paths", () => {
    const synchronize = node("ts:host.ts#synchronizeHooks", "function", "synchronizeHooks", "host.ts", 10);
    const replay = node("ts:binding.ts#replay", "function", "replay", "binding.ts", 5);
    const pushHook = node("ts:binding.ts#pushHook", "function", "pushHook", "binding.ts", 1);
    const register = node("ts:transport.ts#DelegateService.registerHook", "method", "registerHook", "transport.ts", 3);
    const optional = node("ts:host.ts#optionalSibling", "function", "optionalSibling", "host.ts", 12);
    const later = node("ts:host.ts#laterCall", "function", "laterCall", "host.ts", 21);
    const deferred = node("ts:host.ts#deferredCall", "function", "deferredCall", "host.ts", 22);
    const failureOnly = node("ts:host.ts#failureOnly", "function", "failureOnly", "host.ts", 25);
    const nodes = [
      synchronize,
      replay,
      pushHook,
      register,
      optional,
      later,
      deferred,
      failureOnly,
      node(ids.acknowledge, "method", "acknowledgeHookRegistration", "client.ts", 14),
      node(ids.ready, "promise", "_hookRegistrationReady", "client.ts", 5),
      node(ids.bootstrap, "function", "bootstrapIframe", "bootstrap.ts", 1),
    ];
    const edges = [
      edge("resolve", ids.acknowledge, ids.ready, "resolvesPromise", 17),
      edge("await", ids.bootstrap, ids.ready, "awaitsPromise", 50, {
        callSites: [{ file: "bootstrap.ts", line: 50, col: 2, endLine: 50, endCol: 28 }],
      }),
      edge("rpc", synchronize.id, ids.acknowledge, "calls", 20, {
        callSites: [
          { file: "host.ts", line: 20, col: 8, endLine: 20, endCol: 55 },
          { file: "host.ts", line: 26, col: 8, endLine: 26, endCol: 80 },
        ],
      }),
      edge("replay", synchronize.id, replay.id, "calls", 19, {
        callSites: [{ file: "host.ts", line: 19, col: 8, endLine: 19, endCol: 34 }],
      }),
      edge("push", replay.id, pushHook.id, "calls", 7, {
        callSites: [{ file: "binding.ts", line: 7, col: 12, endLine: 7, endCol: 32 }],
      }),
      edge("register", pushHook.id, register.id, "calls", 3, {
        callSites: [{ file: "binding.ts", line: 3, col: 8, endLine: 3, endCol: 58 }],
      }),
      edge("optional", synchronize.id, optional.id, "calls", 12, {
        callSites: [{ file: "host.ts", line: 12 }],
      }),
      edge("later", synchronize.id, later.id, "calls", 21, {
        callSites: [{ file: "host.ts", line: 21 }],
      }),
      edge("deferred", synchronize.id, deferred.id, "calls", 22, {
        callSites: [{ file: "host.ts", line: 22 }],
      }),
      edge("failure", synchronize.id, failureOnly.id, "calls", 25, {
        callSites: [{ file: "host.ts", line: 25 }],
      }),
    ];
    const call = (
      label: string,
      target: string | null,
      file: string,
      line: number,
      awaited = false,
    ): FlowStep => ({
      kind: "call",
      label,
      target,
      resolution: target ? "resolved" : "unresolved",
      ...(awaited ? { awaited: true, async: { kind: "direct-await", taskId: `task:${line}` } as const } : {}),
      source: { file, line },
    });
    const flows: LogicFlows = {
      [synchronize.id]: [{
        kind: "branch",
        label: "try/catch",
        branchKind: "try",
        paths: [
          {
            label: "try",
            role: "try",
            body: [
              {
                kind: "branch",
                label: "if optional",
                branchKind: "if",
                paths: [{ label: "then", role: "then", body: [call("optionalSibling", optional.id, "host.ts", 12)] }],
              },
              call("hookBinding.replay", replay.id, "host.ts", 19, true),
              call("delegateService.acknowledgeHookRegistration", ids.acknowledge, "host.ts", 20, true),
              call("laterCall", later.id, "host.ts", 21),
              { kind: "callback", label: "deferred", body: [call("deferredCall", deferred.id, "host.ts", 22)] },
            ],
          },
          {
            label: "catch error",
            role: "catch",
            body: [
              call("failureOnly", failureOnly.id, "host.ts", 25),
              call("delegateService.acknowledgeHookRegistration", ids.acknowledge, "host.ts", 26, true),
            ],
          },
        ],
      }],
      [replay.id]: [{ kind: "loop", label: "for hook", body: [call("pushHook", pushHook.id, "binding.ts", 7, true)] }],
      [pushHook.id]: [call("delegateService.registerHook", register.id, "binding.ts", 3, true)],
    };
    const graph = artifact(nodes, edges, flows);

    const model = causalSequenceTimelineFor(graph, ids.ready, buildGraphIndex(graph));
    const labels = model?.rows.map((row) => row.label) ?? [];

    expect(labels).toEqual(expect.arrayContaining([
      "await replay()",
      "await pushHook()",
      "await registerHook()",
      "await acknowledgeHookRegistration()",
    ]));
    expect(labels.indexOf("await replay()")).toBeLessThan(labels.indexOf("await acknowledgeHookRegistration()"));
    expect(labels.indexOf("await pushHook()")).toBeGreaterThan(labels.indexOf("await replay()"));
    expect(labels.indexOf("await registerHook()")).toBeGreaterThan(labels.indexOf("await pushHook()"));
    expect(labels).not.toContain("optionalSibling()");
    expect(labels).not.toContain("laterCall()");
    expect(labels).not.toContain("deferredCall()");
    expect(labels).not.toContain("failureOnly()");
  });

  it("expands a proven predecessor before a send boundary and fails closed without boundary sites", () => {
    const sender = node("ts:sender.ts#send", "function", "sendRegistration", "sender.ts", 1);
    const prepare = node("ts:sender.ts#prepare", "function", "prepareRegistration", "sender.ts", 2);
    const channel = node("ipc:postmessage/registration", "channel", "type:registration", "(postmessage)", 1);
    const handler = node("ts:client.ts#receive", "function", "receiveRegistration", "client.ts", 8);
    const nodes = [
      sender,
      prepare,
      channel,
      handler,
      node(ids.acknowledge, "method", "acknowledgeHookRegistration", "client.ts", 14),
      node(ids.ready, "promise", "ready", "client.ts", 5),
      node(ids.bootstrap, "function", "bootstrap", "bootstrap.ts", 1),
    ];
    const edges = [
      edge("prepare", sender.id, prepare.id, "calls", 9, {
        callSites: [{ file: "sender.ts", line: 9 }],
      }),
      edge("send", sender.id, channel.id, "sends", 10, {
        resolution: "unresolved",
        confidence: 0.8,
        callSites: [{ file: "sender.ts", line: 10 }],
      }),
      edge("handle", channel.id, handler.id, "handles", 11, { resolution: "unresolved", confidence: 0.8 }),
      edge("dispatch", handler.id, ids.acknowledge, "calls", 12),
      edge("resolve", ids.acknowledge, ids.ready, "resolvesPromise", 17),
      edge("await", ids.bootstrap, ids.ready, "awaitsPromise", 50, {
        callSites: [{ file: "bootstrap.ts", line: 50, col: 0, endLine: 50, endCol: 14 }],
      }),
    ];
    const flow: FlowStep[] = [
      { kind: "call", label: "prepareRegistration", target: prepare.id, resolution: "resolved", source: { file: "sender.ts", line: 9 } },
      { kind: "call", label: "postMessage", target: null, resolution: "unresolved", source: { file: "sender.ts", line: 10 } },
    ];
    const graph = artifact(nodes, edges, { [sender.id]: flow });
    const labels = causalSequenceTimelineFor(graph, ids.ready, buildGraphIndex(graph))?.rows.map((row) => row.label) ?? [];

    expect(labels).toContain("prepareRegistration()");
    expect(labels).toContain("send · type:registration");
    expect(labels.indexOf("prepareRegistration()")).toBeLessThan(labels.indexOf("send · type:registration"));

    const withoutBoundarySite = artifact(nodes, edges.map((candidate) =>
      candidate.id === "send" ? { ...candidate, callSites: [] } : candidate), { [sender.id]: flow });
    const labelsWithoutEvidence = causalSequenceTimelineFor(
      withoutBoundarySite,
      ids.ready,
      buildGraphIndex(withoutBoundarySite),
    )?.rows.map((row) => row.label) ?? [];
    expect(labelsWithoutEvidence).not.toContain("prepareRegistration()");
  });

  it("marks the projection when the selected predecessor expansion itself reaches its guard", () => {
    const synchronize = node("ts:sync.ts#sync", "function", "synchronize", "sync.ts", 1);
    const predecessors = Array.from({ length: 5 }, (_, index) =>
      node(`ts:step.ts#step${index}`, "function", `step${index}`, "step.ts", index + 1));
    const acknowledge = node(ids.acknowledge, "method", "acknowledgeHookRegistration", "client.ts", 14);
    const ready = node(ids.ready, "promise", "ready", "client.ts", 5);
    const bootstrap = node(ids.bootstrap, "function", "bootstrap", "bootstrap.ts", 1);
    const call = (target: GraphNode, file: string, line: number): FlowStep => ({
      kind: "call",
      label: target.displayName,
      target: target.id,
      resolution: "resolved",
      source: { file, line },
    });
    const graph = artifact([
      synchronize,
      ...predecessors,
      acknowledge,
      ready,
      bootstrap,
    ], [
      edge("await", bootstrap.id, ready.id, "awaitsPromise", 50, {
        callSites: [{ file: "bootstrap.ts", line: 50, endLine: 50, endCol: 20 }],
      }),
      edge("resolve", acknowledge.id, ready.id, "resolvesPromise", 17),
      edge("first", synchronize.id, predecessors[0]!.id, "calls", 1, {
        callSites: [{ file: "sync.ts", line: 1 }],
      }),
      edge("settle", synchronize.id, acknowledge.id, "calls", 2, {
        callSites: [{ file: "sync.ts", line: 2 }],
      }),
      ...predecessors.slice(0, -1).map((source, index) => edge(
        `step-${index}`,
        source.id,
        predecessors[index + 1]!.id,
        "calls",
        index + 1,
        { callSites: [{ file: "step.ts", line: index + 1 }] },
      )),
    ], {
      [synchronize.id]: [
        call(predecessors[0]!, "sync.ts", 1),
        call(acknowledge, "sync.ts", 2),
      ],
      ...Object.fromEntries(predecessors.slice(0, -1).map((source, index) => [
        source.id,
        [call(predecessors[index + 1]!, "step.ts", index + 1)],
      ])),
    });

    const model = causalSequenceTimelineFor(graph, ready.id, buildGraphIndex(graph));
    const labels = model?.rows.map((row) => row.label) ?? [];

    expect(labels).toContain("step3()");
    expect(labels).not.toContain("step4()");
    expect(model?.truncated).toBe(true);
  });

  it("uses component lifelines for nested functions and one lifeline per transport lane", () => {
    const hostModule = node("ts:host.ts", "module", "host.ts", "host.ts", 1);
    const sync = node("ts:host.ts#wire", "function", "wireDelegateHost", "host.ts", 5, hostModule.id);
    const replay = node("ts:host.ts#wire.replay", "function", "replay", "host.ts", 7, sync.id);
    const iframeModule = node("ts:iframe.ts", "module", "iframe.ts", "iframe.ts", 1);
    const bootstrap = node("ts:iframe.ts#bootstrap", "function", "bootstrapIframe", "iframe.ts", 3, iframeModule.id);
    const client = node("ts:client.ts#Client", "class", "DelegateClient", "client.ts", 1);
    const acknowledge = node("ts:client.ts#Client.ack", "method", "acknowledgeHookRegistration", "client.ts", 4, client.id);
    const register = node("ts:client.ts#Client.register", "method", "registerHook", "client.ts", 8, client.id);
    const ready = node("promise:client.ts#ready", "promise", "ready", "client.ts", 2, client.id);
    const ackChannel = node("ipc:rpc/lane=request/channel=delegate.ack", "channel", "delegate.ack", "(rpc)", 1);
    const registerChannel = node("ipc:rpc/lane=request/channel=delegate.register", "channel", "delegate.register", "(rpc)", 1);
    const graph = artifact([
      hostModule,
      sync,
      replay,
      iframeModule,
      bootstrap,
      client,
      acknowledge,
      register,
      ready,
      ackChannel,
      registerChannel,
    ], [
      edge("await", bootstrap.id, ready.id, "awaitsPromise", 20, {
        callSites: [{ file: "iframe.ts", line: 20, col: 2, endLine: 20, endCol: 18 }],
      }),
      edge("resolve", acknowledge.id, ready.id, "resolvesPromise", 5),
      edge("replay", sync.id, replay.id, "calls", 9, {
        callSites: [{ file: "host.ts", line: 9 }],
      }),
      edge("register-send", replay.id, registerChannel.id, "sends", 3, {
        callSites: [{ file: "host.ts", line: 3 }],
      }),
      edge("register-handle", registerChannel.id, register.id, "handles", 8),
      edge("ack-send", sync.id, ackChannel.id, "sends", 10, {
        callSites: [{ file: "host.ts", line: 10 }],
      }),
      edge("ack-handle", ackChannel.id, acknowledge.id, "handles", 4),
    ], {
      [sync.id]: [
        { kind: "call", label: "replay", target: replay.id, resolution: "resolved", awaited: true, source: { file: "host.ts", line: 9 } },
        { kind: "call", label: "remote.ack", target: null, resolution: "unresolved", awaited: true, source: { file: "host.ts", line: 10 } },
      ],
      [replay.id]: [
        { kind: "call", label: "remote.register", target: null, resolution: "unresolved", awaited: true, source: { file: "host.ts", line: 3 } },
      ],
    });

    const model = causalSequenceTimelineFor(graph, ready.id, buildGraphIndex(graph));

    expect(model?.participants.map((participant) => participant.label)).toEqual([
      "bootstrapIframe",
      "wireDelegateHost",
      "RPC transport",
      "DelegateClient",
      "ready",
    ]);
    expect(model?.participants.filter((participant) => participant.label === "RPC transport")).toHaveLength(1);
    expect(model?.participants.map((participant) => participant.label)).not.toContain("replay");
  });

  it("preserves causal-slice truncation in the projected model", () => {
    const causes = Array.from({ length: 9 }, (_, index) =>
      node(`ts:cause.ts#cause${index}`, "function", `cause${index}`, "cause.ts", index + 1));
    const graph = artifact([
      ...causes,
      node(ids.acknowledge, "function", "acknowledge", "client.ts", 14),
      node(ids.ready, "promise", "ready", "client.ts", 5),
      node(ids.bootstrap, "function", "bootstrap", "bootstrap.ts", 1),
    ], [
      ...causes.slice(0, -1).map((cause, index) =>
        edge(`cause-${index}`, cause.id, causes[index + 1]!.id, "calls", index + 1)),
      edge("settle-cause", causes.at(-1)!.id, ids.acknowledge, "calls", 10),
      edge("resolve", ids.acknowledge, ids.ready, "resolvesPromise", 15),
      edge("await", ids.bootstrap, ids.ready, "awaitsPromise", 20),
    ]);

    const model = causalSequenceTimelineFor(graph, ids.ready, buildGraphIndex(graph));

    expect(model).not.toBeNull();
    expect(model?.truncated).toBe(true);
  });

  it("does not mark a complete focused sequence truncated for an unrelated deep branch", () => {
    const causeModule = node("ts:cause.ts", "module", "cause.ts", "cause.ts", 1);
    // Promise <- acknowledge is one hop, so seven callers end exactly at the depth-eight bound.
    // That complete upstream path must not inherit truncation from the unrelated forward branch.
    const causes = Array.from({ length: 7 }, (_, index) =>
      node(`ts:cause.ts#cause${index}`, "function", `cause${index}`, "cause.ts", index + 1, causeModule.id));
    const deep = Array.from({ length: 9 }, (_, index) =>
      node(`ts:deep.ts#deep${index}`, "function", `deep${index}`, "deep.ts", index + 1));
    const graph = artifact([
      node(ids.wait, "method", "waitForHookRegistration", "client.ts", 10),
      node(ids.acknowledge, "method", "acknowledgeHookRegistration", "client.ts", 14),
      node(ids.ready, "promise", "_hookRegistrationReady", "client.ts", 5),
      node(ids.bootstrap, "function", "bootstrapIframe", "bootstrap.ts", 1),
      causeModule,
      ...causes,
      ...deep,
    ], [
      edge("return", ids.wait, ids.ready, "returnsPromise", 11),
      edge("await", ids.bootstrap, ids.ready, "awaitsPromise", 20),
      edge("call-wait", ids.bootstrap, ids.wait, "calls", 20),
      edge("resolve", ids.acknowledge, ids.ready, "resolvesPromise", 15),
      ...causes.slice(0, -1).map((source, index) =>
        edge(`cause-${index}`, source.id, causes[index + 1]!.id, "calls", index + 1)),
      edge("settle-cause", causes.at(-1)!.id, ids.acknowledge, "calls", 10),
      edge("after-wait", ids.bootstrap, deep[0]!.id, "calls", 30),
      ...deep.slice(0, -1).map((source, index) =>
        edge(`deep-${index}`, source.id, deep[index + 1]!.id, "calls", index + 1)),
    ], {
      [ids.bootstrap]: [
        {
          kind: "call",
          label: "client.waitForHookRegistration",
          target: ids.wait,
          resolution: "resolved",
          awaited: true,
          source: { file: "bootstrap.ts", line: 20 },
        },
        {
          kind: "call",
          label: "deep0",
          target: deep[0]!.id,
          resolution: "resolved",
          source: { file: "bootstrap.ts", line: 30 },
        },
      ],
    });

    const model = causalSequenceTimelineFor(graph, ids.ready, buildGraphIndex(graph));

    expect(model?.rows.map((row) => row.label)).toContain("deep0()");
    expect(model?.truncated).toBe(false);
  });

  it("does not confuse a node-bound fan-out below a shown consequence with a cut sequence", () => {
    const consequence = node("ts:effect.ts#effect", "function", "effect", "effect.ts", 1);
    const leaves = Array.from({ length: 140 }, (_, index) =>
      node(`ts:leaf.ts#leaf${index}`, "function", `leaf${index}`, "leaf.ts", index + 1));
    const graph = artifact([
      node(ids.wait, "method", "waitForHookRegistration", "client.ts", 10),
      node(ids.acknowledge, "method", "acknowledgeHookRegistration", "client.ts", 14),
      node(ids.ready, "promise", "_hookRegistrationReady", "client.ts", 5),
      node(ids.bootstrap, "function", "bootstrapIframe", "bootstrap.ts", 1),
      consequence,
      ...leaves,
    ], [
      edge("return", ids.wait, ids.ready, "returnsPromise", 11),
      edge("await", ids.bootstrap, ids.ready, "awaitsPromise", 20),
      edge("call-wait", ids.bootstrap, ids.wait, "calls", 20),
      edge("resolve", ids.acknowledge, ids.ready, "resolvesPromise", 15),
      edge("after-wait", ids.bootstrap, consequence.id, "calls", 30),
      ...leaves.map((leaf, index) => edge(`fan-out-${index}`, consequence.id, leaf.id, "calls", index + 1)),
    ], {
      [ids.bootstrap]: [
        {
          kind: "call",
          label: "client.waitForHookRegistration",
          target: ids.wait,
          resolution: "resolved",
          awaited: true,
          source: { file: "bootstrap.ts", line: 20 },
        },
        {
          kind: "call",
          label: "effect",
          target: consequence.id,
          resolution: "resolved",
          source: { file: "bootstrap.ts", line: 30 },
        },
      ],
    });

    const model = causalSequenceTimelineFor(graph, ids.ready, buildGraphIndex(graph));

    expect(model?.rows.map((row) => row.label)).toContain("effect()");
    expect(model?.truncated).toBe(false);
  });

  it("renders generic IPC send/handle facts and keeps candidate confidence visible", () => {
    const sender = node("ts:transport.ts#send", "function", "send", "transport.ts", 1);
    const channel = node(
      "ipc:postmessage/lane=window-message/channel=type%3Aready",
      "channel",
      "type:ready",
      "(postmessage)",
      1,
    );
    const handler = node("ts:transport.ts#receive", "function", "receive", "transport.ts", 20);
    const edges = [
      edge("send", sender.id, channel.id, "sends", 4, { resolution: "unresolved", confidence: 0.65 }),
      edge("handle", channel.id, handler.id, "handles", 22, { resolution: "unresolved", confidence: 0.65 }),
    ];
    const graph = artifact([sender, channel, handler], edges);
    const model = causalSequenceTimelineFor(graph, sender.id, buildGraphIndex(graph));

    expect(model?.participants.map((participant) => participant.label)).toEqual(["send", "type:ready", "receive"]);
    expect(model?.rows.map((row) => row.label)).toEqual([
      "send · type:ready",
      "candidate correlation · 65% confidence",
      "deliver · type:ready",
    ]);
  });

  it("collapses actors beyond the participant guard into an explicit overflow lifeline", () => {
    const senders = Array.from({ length: 5 }, (_, index) =>
      node(`ts:sender${index}.ts#send${index}`, "function", `send${index}`, `sender${index}.ts`, 1));
    const handlers = Array.from({ length: 4 }, (_, index) =>
      node(`ts:handler${index}.ts#receive${index}`, "function", `receive${index}`, `handler${index}.ts`, 1));
    const channel = node(
      "ipc:postmessage/lane=window-message/channel=type%3Amany",
      "channel",
      "type:many",
      "(postmessage)",
      1,
    );
    const graph = artifact([...senders, channel, ...handlers], [
      ...senders.map((sender, index) =>
        edge(`send-${index}`, sender.id, channel.id, "sends", index + 1)),
      ...handlers.map((handler, index) =>
        edge(`handle-${index}`, channel.id, handler.id, "handles", index + 10)),
    ]);

    const model = causalSequenceTimelineFor(graph, channel.id, buildGraphIndex(graph));
    const overflow = model?.participants.find((participant) => participant.kind === "overflow");
    const firstSender = model?.participants.find((participant) => participant.nodeId === senders[0]!.id);
    const boundary = model?.participants.find((participant) => participant.label === "type:many");

    expect(model?.participants).toHaveLength(8);
    expect(overflow).toMatchObject({
      label: "More participants",
      detail: "collapsed by size guard",
      nodeId: null,
    });
    expect(model?.truncated).toBe(true);
    expect(model?.rows.find((row) => row.type === "message" && row.target === senders[0]!.id)).toMatchObject({
      from: firstSender?.id,
      to: boundary?.id,
    });
    expect(model?.rows.find((row) => row.type === "message" && row.target === handlers.at(-1)!.id)).toMatchObject({
      from: boundary?.id,
      to: overflow?.id,
    });
    expect(firstSender?.id).not.toBe(overflow?.id);
    expect(boundary?.id).not.toBe(overflow?.id);
  });

  it("does not invent a returned-method call for a direct Promise await", () => {
    const nodes = [
      node(ids.client, "class", "Client", "client.ts", 1),
      node(ids.wait, "method", "wait", "client.ts", 10, ids.client),
      node(ids.ready, "promise", "ready", "client.ts", 5, ids.client),
      node(ids.bootstrap, "function", "bootstrap", "bootstrap.ts", 1),
    ];
    const graph = artifact(nodes, [
      edge("create", ids.client, ids.ready, "createsPromise", 5),
      edge("return", ids.wait, ids.ready, "returnsPromise", 11),
      edge("await", ids.bootstrap, ids.ready, "awaitsPromise", 20),
    ]);

    const model = causalSequenceTimelineFor(graph, ids.ready, buildGraphIndex(graph));

    expect(model?.rows.map((row) => row.label)).toContain("await ready");
    expect(model?.rows.map((row) => row.label)).not.toContain("await wait()");
  });

  it("returns null for an ordinary selection with no causal resource", () => {
    const plain = node("ts:plain.ts#plain", "function", "plain", "plain.ts", 1);
    const graph = artifact([plain], []);
    expect(causalSequenceTimelineFor(graph, plain.id, buildGraphIndex(graph))).toBeNull();
  });
});
