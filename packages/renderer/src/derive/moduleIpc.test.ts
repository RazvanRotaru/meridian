/**
 * IPC edge derivation for the Map: a `sends` half and a `handles` half meet on a channel; the join
 * is a sender→handler edge. Channels collapse away; intra-endpoint loops and non-IPC edges drop.
 */

import { describe, expect, it } from "vitest";
import type { GraphEdge } from "@meridian/core";
import { buildIpcEdges } from "./moduleIpc";

function edge(kind: string, source: string, target: string): GraphEdge {
  return { id: `${kind}@${source}|${target}`, source, target, kind } as GraphEdge;
}

describe("buildIpcEdges", () => {
  it("joins a channel's senders to its handlers, dropping the channel", () => {
    const edges = [
      edge("sends", "ts:a.ts#send", "ipc:http/GET+/x"),
      edge("handles", "ipc:http/GET+/x", "ts:b.ts#handle"),
    ];
    const ipc = buildIpcEdges(edges);
    expect(ipc.map((e) => `${e.source}->${e.target}`)).toEqual(["ts:a.ts#send->ts:b.ts#handle"]);
    expect(ipc[0].kind).toBe("ipc");
  });

  it("fans a channel out to every sender × handler pair", () => {
    const edges = [
      edge("sends", "ts:a#s1", "ipc:c"),
      edge("sends", "ts:a#s2", "ipc:c"),
      edge("handles", "ipc:c", "ts:b#h"),
    ];
    expect(buildIpcEdges(edges).map((e) => `${e.source}->${e.target}`).sort()).toEqual([
      "ts:a#s1->ts:b#h",
      "ts:a#s2->ts:b#h",
    ]);
  });

  it("dedupes a pair that meets on more than one channel, and drops self-loops", () => {
    const edges = [
      edge("sends", "ts:a#s", "ipc:c1"),
      edge("handles", "ipc:c1", "ts:b#h"),
      edge("sends", "ts:a#s", "ipc:c2"),
      edge("handles", "ipc:c2", "ts:b#h"),
      edge("sends", "ts:self#f", "ipc:c3"),
      edge("handles", "ipc:c3", "ts:self#f"), // sender IS the handler → not a wire
    ];
    expect(buildIpcEdges(edges).map((e) => `${e.source}->${e.target}`)).toEqual(["ts:a#s->ts:b#h"]);
  });

  it("ignores non sends/handles edges", () => {
    expect(buildIpcEdges([edge("calls", "ts:a#f", "ts:b#g"), edge("imports", "ts:a.ts", "ts:b.ts")])).toEqual([]);
  });
});
