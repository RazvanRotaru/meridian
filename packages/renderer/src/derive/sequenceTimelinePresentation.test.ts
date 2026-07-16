import { describe, expect, it } from "vitest";
import type { SequenceTimelineModel } from "./sequenceTimelineModel";
import { buildSequencePresentation } from "./sequenceTimelinePresentation";

const MODEL: SequenceTimelineModel = {
  participants: [
    { id: "caller", kind: "node", label: "Caller", detail: null, nodeId: "caller" },
    { id: "callee", kind: "node", label: "Callee", detail: null, nodeId: "callee" },
  ],
  rows: [
    {
      id: "call",
      type: "message",
      row: 0,
      kind: "call",
      tone: "await",
      from: "caller",
      to: "callee",
      label: "await register()",
      target: "callee",
      drillable: true,
      visualRole: "primary",
    },
    {
      id: "wait-detail",
      type: "note",
      row: 1,
      participant: "caller",
      tone: "wait",
      label: "waits here for register()",
      visualRole: "detail",
    },
    {
      id: "return-detail",
      type: "message",
      row: 2,
      kind: "return",
      tone: "call",
      from: "callee",
      to: "caller",
      label: "returns",
      target: "callee",
      drillable: false,
      visualRole: "detail",
    },
    {
      id: "resolved",
      type: "message",
      row: 3,
      kind: "return",
      tone: "await",
      from: "callee",
      to: "caller",
      label: "resolves",
      target: "callee",
      drillable: false,
      visualRole: "primary",
    },
    {
      id: "exit",
      type: "note",
      row: 4,
      participant: "caller",
      tone: "exit",
      label: "return session",
      visualRole: "primary",
    },
  ],
  frames: [
    { id: "outer", kind: "alt", label: "registration", startRow: 0, endRow: 4, separators: [{ row: 3, label: "failure" }] },
    { id: "detail-only", kind: "loop", label: "details", startRow: 1, endRow: 2, separators: [] },
  ],
  truncated: false,
  guards: { maxInlineDepth: 1, maxParticipants: 8, maxRows: 96 },
};

describe("buildSequencePresentation", () => {
  it("removes redundant detail rows and remaps visible frame boundaries without changing semantics", () => {
    const presentation = buildSequencePresentation(MODEL);

    expect(presentation.rows.map((row) => [row.row, row.label])).toEqual([
      [0, "await register()"],
      [1, "resolves"],
      [2, "return session"],
    ]);
    expect(presentation.frames).toEqual([
      expect.objectContaining({ id: "outer", startRow: 0, endRow: 2, separators: [{ row: 1, label: "failure" }] }),
    ]);
    expect(MODEL.rows).toHaveLength(5);
    expect(MODEL.frames).toHaveLength(2);
  });
});
