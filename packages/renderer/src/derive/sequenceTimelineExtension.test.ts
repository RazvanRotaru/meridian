import { describe, expect, it } from "vitest";
import type { GraphArtifact } from "@meridian/core";
import { sequenceTimelineFor } from "./sequenceTimelineExtension";

const ROOT = "ts:src/bootstrap.ts#bootstrap";

function artifact(sequenceTimeline: unknown): GraphArtifact {
  return {
    schemaVersion: "1.1.0",
    generatedAt: "2026-07-15T00:00:00.000Z",
    generator: { name: "test", version: "1" },
    target: { name: "test", root: ".", language: "typescript" },
    nodes: [],
    edges: [],
    extensions: { sequenceTimeline } as GraphArtifact["extensions"],
  };
}

describe("sequenceTimelineFor", () => {
  it("reads an artifact-authored causal model for one exact root", () => {
    const model = sequenceTimelineFor(artifact({
      [ROOT]: {
        participants: [
          { id: "iframe", kind: "node", label: "Iframe", detail: null, nodeId: ROOT },
          { id: "client", kind: "node", label: "Client", detail: null, nodeId: ROOT },
        ],
        rows: [{
          id: "wait",
          type: "message",
          row: 0,
          kind: "call",
          tone: "await",
          from: "iframe",
          to: "client",
          label: "waitForHookRegistration()",
          visualRole: "primary",
          target: ROOT,
          drillable: true,
        }],
        frames: [],
        truncated: false,
      },
    }), ROOT);

    expect(model?.participants.map((participant) => participant.label)).toEqual(["Iframe", "Client"]);
    expect(model?.rows[0]).toMatchObject({ label: "waitForHookRegistration()" });
  });

  it("rejects a model whose rows point outside its participant set", () => {
    expect(sequenceTimelineFor(artifact({
      [ROOT]: {
        participants: [{ id: "iframe", kind: "node", label: "Iframe", detail: null, nodeId: ROOT }],
        rows: [{
          id: "wait",
          type: "message",
          row: 0,
          kind: "call",
          tone: "await",
          from: "iframe",
          to: "missing",
          label: "wait",
          visualRole: "primary",
          target: ROOT,
          drillable: true,
        }],
        frames: [],
      },
    }), ROOT)).toBeNull();
  });
});
