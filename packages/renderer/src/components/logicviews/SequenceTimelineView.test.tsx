import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { FlowStep, LogicFlows } from "@meridian/core";
import type { GraphIndex } from "../../graph/graphIndex";
import type { SequenceTimelineModel } from "../../derive/sequenceTimelineModel";
import { SequenceTimelineView } from "./SequenceTimelineView";

const ROOT = "ts:src/bootstrap.ts#bootstrap";
const HOST = "ts:src/host.ts#HostBinding";
const REGISTER = "ts:src/host.ts#HostBinding.registerHooks";
const STORE = "ts:src/store.ts#addHook";

const STEPS: FlowStep[] = [
  {
    kind: "loop",
    label: "each registered hook",
    body: [{ kind: "call", label: "registerHooks()", target: REGISTER, resolution: "resolved", awaited: true }],
  },
  {
    kind: "branch",
    label: "registration result",
    branchKind: "if",
    paths: [
      { label: "success", role: "then", body: [{ kind: "exit", variant: "return", label: "session" }] },
      { label: "failure", role: "else", body: [{ kind: "exit", variant: "throw", label: "error" }] },
    ],
  },
];

const FLOWS: LogicFlows = {
  [REGISTER]: [
    { kind: "call", label: "addHook()", target: STORE, resolution: "resolved" },
    { kind: "exit", variant: "return", label: "ready" },
  ],
};

const INDEX = {
  nodesById: new Map([
    [ROOT, { id: ROOT, kind: "function", displayName: "bootstrap", location: { file: "src/bootstrap.ts", startLine: 1 } }],
    [HOST, { id: HOST, kind: "class", displayName: "Host binding", location: { file: "src/host.ts", startLine: 1 } }],
    [REGISTER, { id: REGISTER, kind: "method", displayName: "registerHooks", parentId: HOST, location: { file: "src/host.ts", startLine: 12 } }],
    [STORE, { id: STORE, kind: "function", displayName: "addHook", location: { file: "src/store.ts", startLine: 4 } }],
  ]),
  parentOf: new Map([
    [ROOT, null],
    [HOST, null],
    [REGISTER, HOST],
    [STORE, null],
  ]),
  changedStatus: new Map([[REGISTER, "added"]]),
} as unknown as GraphIndex;

function render(options: {
  selected?: string | null;
  density?: "full" | "compact";
  drillEnabled?: boolean;
  showZoomControls?: boolean;
  modelOverride?: SequenceTimelineModel;
} = {}) {
  return renderToStaticMarkup(
    <SequenceTimelineView
      rootId={ROOT}
      steps={STEPS}
      flows={FLOWS}
      index={INDEX}
      selected={options.selected ?? REGISTER}
      density={options.density}
      drillEnabled={options.drillEnabled}
      showZoomControls={options.showZoomControls}
      modelOverride={options.modelOverride}
      onSelect={() => undefined}
      onDrill={() => undefined}
    />,
  );
}

describe("SequenceTimelineView", () => {
  it("renders lifelines, primary calls, meaningful returns, quiet structure dividers, and compact notes", () => {
    const markup = render();

    expect(markup).toContain('data-sequence-svg="true"');
    expect(markup).toContain('data-sequence-lifeline="sequence:node:ts:src/host.ts#HostBinding"');
    expect(markup).toContain('data-sequence-message-kind="call"');
    expect(markup).toContain('data-sequence-message-kind="return"');
    expect(markup).toContain('stroke-dasharray="7 6"');
    expect(markup).toContain('data-sequence-frame-kinds="loop"');
    expect(markup).toContain('data-sequence-frame-kinds="alt"');
    expect(markup).not.toContain('data-sequence-note="wait"');
    expect(markup).toContain('data-sequence-note="exit"');
  });

  it("keeps redundant waits and generic returns in the transcript without giving them visual rows", () => {
    const markup = render();
    const visibleReturnLabels = markup.match(/data-sequence-message-label="return"/g) ?? [];

    expect(visibleReturnLabels).toHaveLength(1);
    expect(markup).toContain("Return from addHook to Host binding: returns.");
    expect(markup).toContain("Wait at bootstrap: waits here for registerHooks().");
  });

  it("keeps actor sources and exact call targets keyboard-accessible for linked selection/drill", () => {
    const markup = render();

    expect(markup).toContain('aria-label="Select bootstrap"');
    expect(markup).toContain('aria-label="Select Host binding"');
    expect(markup).toContain('aria-label="Select call target await registerHooks()"');
    expect(markup).toMatch(/<button(?=[^>]*aria-label="Select call target await registerHooks\(\)")(?=[^>]*aria-pressed="true")[^>]*>/);
    expect(markup).toContain('aria-keyshortcuts="Shift+Enter"');
  });

  it("shows the PR status of the exact callee even when its actor lane is grouped by owner", () => {
    const markup = render();

    expect(markup).toContain('data-sequence-message-content="true"');
    expect(markup).toContain('data-sequence-message-text="true"');
    expect(markup).toContain('data-sequence-target-change-line="true"');
    expect(markup).toContain('data-sequence-target-change-placement="below-wire"');
    expect(markup).toMatch(/data-sequence-target-change-line="true"[^>]*style="[^"]*position:absolute/);
    expect(markup).toContain("TARGET ADDED");
    expect(markup).toContain('aria-label="Call target added in this PR"');
    expect(markup).toContain('data-pr-target-change-status="added"');
    expect(markup).not.toContain('data-pr-change-marker="true"');
    expect(markup.indexOf('data-sequence-message-text="true"')).toBeLessThan(
      markup.indexOf('data-sequence-target-change-line="true"'),
    );
  });

  it.each(["full", "compact"] as const)(
    "places target-change pills below their wire with room before the next row in %s density",
    (density) => {
      const markup = render({ density });
      const firstWireY = numberFromMarkup(
        markup,
        /<button[^>]*data-sequence-message-label="call"[^>]*data-sequence-message-row="0"[^>]*data-sequence-message-y="([^"]+)"/,
      );
      const targetChangeY = numberFromMarkup(
        markup,
        /data-sequence-target-change-line="true"[^>]*data-sequence-target-change-y="([^"]+)"/,
      );
      const messageYs = [...markup.matchAll(/data-sequence-message-y="([^"]+)"/g)]
        .map((match) => Number(match[1]))
        .filter((value, index, values) => index === 0 || value !== values[index - 1]);

      expect(targetChangeY).toBe(firstWireY + 6);
      expect(messageYs[1]).toBeDefined();
      // A divider may sit 44 px before the next wire. The 16 px pill still keeps 6 px clear.
      expect(targetChangeY + 16 + 6).toBeLessThanOrEqual(messageYs[1]! - 44);
    },
  );

  it("supports compact sizing and review-only drill suppression", () => {
    const markup = render({ density: "compact", drillEnabled: false });

    expect(markup).toContain('data-sequence-density="compact"');
    expect(markup).not.toContain('aria-label="Sequence diagram zoom"');
    expect(markup).not.toContain("aria-keyshortcuts");
  });

  it("offers optional local zoom controls in the full view", () => {
    const markup = render({ selected: null });

    expect(markup).toContain('aria-label="Sequence diagram zoom"');
    expect(markup).toContain('data-preserves-sequence-selection="true"');
    expect(markup).toContain('aria-label="Zoom out"');
    expect(markup).toContain('aria-label="Reset zoom"');
    expect(markup).toContain('aria-label="Zoom in"');
  });

  it("renders an artifact-authored causal model instead of deriving one intraprocedural root", () => {
    const markup = render({
      modelOverride: {
        participants: [
          { id: "host", kind: "node", label: "Host", detail: null, nodeId: HOST },
          { id: "iframe", kind: "node", label: "Iframe", detail: null, nodeId: ROOT },
        ],
        rows: [{
          id: "barrier",
          type: "message",
          row: 0,
          kind: "call",
          tone: "await",
          from: "iframe",
          to: "host",
          label: "cross-RPC barrier",
          visualRole: "primary",
          target: HOST,
          drillable: true,
        }],
        frames: [],
        truncated: false,
        guards: { maxInlineDepth: 1, maxParticipants: 8, maxRows: 96 },
      },
    });

    expect(markup).toContain("cross-RPC barrier");
    expect(markup).toContain("Participant 1 of 2: Host.");
    expect(markup).not.toContain('data-sequence-target-change-line="true"');
    expect(markup).not.toContain("registerHooks()");
  });

  it("provides a chronological accessible transcript with actor direction and frame boundaries", () => {
    const markup = render();

    expect(markup).toContain('data-sequence-transcript="true"');
    expect(markup).toContain('aria-label="Sequence participants"');
    expect(markup).toContain("Participants from left to right:");
    expect(markup).toContain("Participant 1 of 3: bootstrap.");
    expect(markup).toContain("Call from bootstrap to Host binding: await registerHooks().");
    expect(markup).toContain("Begin loop frame: each registered hook.");
    expect(markup).toContain("Begin alternative frame: registration result · success.");
    expect(markup).toContain("Alternative path: failure.");
    expect(markup).toContain("End alternative frame: registration result · success.");

    const loopStart = markup.indexOf("Begin loop frame: each registered hook.");
    const firstCall = markup.indexOf("Call from bootstrap to Host binding: await registerHooks().");
    const loopEnd = markup.indexOf("End loop frame: each registered hook.");
    expect(loopStart).toBeLessThan(firstCall);
    expect(firstCall).toBeLessThan(loopEnd);
  });

  it.each(["full", "compact"] as const)(
    "keeps the quiet structure divider clear of the first message in %s density",
    (density) => {
      const markup = render({ density });
      const structureY = numberFromMarkup(
        markup,
        /<g data-sequence-structure-row="0"[^>]*data-sequence-structure-y="([^"]+)"/,
      );
      const firstMessageY = numberFromMarkup(
        markup,
        /<button[^>]*data-sequence-message-label="call"[^>]*data-sequence-message-row="0"[^>]*data-sequence-message-y="([^"]+)"/,
      );

      // Self-call labels can rise 32 px above their wire; the compact 18 px divider label clears it.
      expect(structureY + 9).toBeLessThan(firstMessageY - 32);
    },
  );
});

function numberFromMarkup(markup: string, pattern: RegExp): number {
  const match = pattern.exec(markup);
  expect(match).not.toBeNull();
  return Number(match?.[1]);
}
