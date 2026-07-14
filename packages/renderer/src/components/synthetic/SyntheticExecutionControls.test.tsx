import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { GraphArtifact, SyntheticScenarioDescriptor } from "@meridian/core";
import { buildGraphIndex } from "../../graph/graphIndex";
import { StoreProvider } from "../../state/StoreContext";
import { createBlueprintStore } from "../../state/store";
import { STATIC_LOGIC_VIEW_MODES } from "../../derive/flowViewModel";
import { LogicViewTabs } from "../logicviews/LogicViewTabs";
import { SyntheticInputEditor } from "./SyntheticExecutionControls";
import { syntheticConsentScopeKey } from "./useSyntheticExecutionController";

const ROOT = "ts:src/order.ts#placeOrder";
const OTHER = "ts:src/order.ts#getOrder";

const ARTIFACT: GraphArtifact = {
  schemaVersion: "1.0.0",
  generatedAt: "2026-07-13T00:00:00.000Z",
  generator: { name: "test", version: "0" },
  target: { name: "fixture", root: ".", language: "typescript" },
  nodes: [{
    id: ROOT,
    kind: "function",
    qualifiedName: "placeOrder",
    displayName: "placeOrder",
    location: { file: "src/order.ts", startLine: 1 },
  }],
  edges: [],
  extensions: { logicFlow: { [ROOT]: [] } },
};

const SCENARIO: SyntheticScenarioDescriptor = {
  id: "place-order-happy",
  label: "Place order — happy path",
  rootId: ROOT,
  defaultInput: { customerId: "cust_1" },
};

describe("Logic synthetic execution controls", () => {
  it.each(STATIC_LOGIC_VIEW_MODES)("shows the launcher in the $label projection", ({ mode }) => {
    const markup = renderControls({ mode });
    expect(markup).toContain("Generate synthetic data");
    expect(markup).toContain('aria-expanded="false"');
    expect(markup).toContain('aria-label="Synthetic execution controls"');
  });

  it("keeps the launcher visible without the local execution capability", () => {
    const markup = renderControls({ endpoint: null });
    expect(markup).toContain("Generate synthetic data");
    expect(markup).toContain('aria-expanded="false"');
  });

  it("keeps the launcher visible when the Logic root still needs a scenario", () => {
    const markup = renderControls({ rootId: OTHER });
    expect(markup).toContain("Generate synthetic data");
    expect(markup).toContain('aria-expanded="false"');
  });

  it("requires explicit, unchecked consent for an untrusted PR sandbox run", () => {
    const unconfirmed = renderSandboxEditor(false);
    const confirmed = renderSandboxEditor(true);

    expect(unconfirmed).toContain("UNTRUSTED PR SANDBOX");
    expect(unconfirmed).toContain("ephemeral OCI sandbox");
    expect(unconfirmed).toContain("Network is disabled");
    expect(unconfirmed).toContain("source and root are read-only");
    expect(unconfirmed).toContain("no host credentials or writable workspace mounts");
    expect(unconfirmed).toContain("CPU, memory, processes, and time are bounded");
    expect(unconfirmed).toContain("acme/shopfront · abcdef123456");
    expect(unconfirmed).toContain("I understand this runs untrusted PR code in the isolated sandbox.");
    expect(buttonTag(unconfirmed, "Run scenario")).toContain("disabled");
    expect(confirmed).toContain('checked=""');
    expect(buttonTag(confirmed, "Run scenario")).not.toContain("disabled");
  });

  it("keeps the trusted-local editor unchanged and consent-free", () => {
    const markup = renderToStaticMarkup(
      <SyntheticInputEditor
        scenario={SCENARIO}
        scenarios={[SCENARIO]}
        value={JSON.stringify(SCENARIO.defaultInput)}
        status="idle"
        error={null}
        executionTrust={{ mode: "local" }}
        sandboxConsent={false}
        onChange={vi.fn()}
        onSandboxConsentChange={vi.fn()}
        onScenarioChange={vi.fn()}
        onCancel={vi.fn()}
        onRun={vi.fn()}
      />,
    );
    expect(markup).toContain("Runs trusted local project code on this machine.");
    expect(markup).not.toContain("UNTRUSTED PR SANDBOX");
    expect(buttonTag(markup, "Run scenario")).not.toContain("disabled");
  });

  it("invalidates consent when the endpoint or immutable PR provenance changes", () => {
    const scope = (endpoint: string, repository: string, headSha: string) => syntheticConsentScopeKey({
      endpoint,
      trust: { mode: "sandboxed-pr", provenance: { repository, headSha } },
      rootId: ROOT,
      scenarioId: SCENARIO.id,
    });
    const original = scope("/api/synthetic-executions?id=pr-1", "acme/shopfront", "aaaa1111");

    expect(scope("/api/synthetic-executions?id=pr-2", "acme/shopfront", "aaaa1111")).not.toBe(original);
    expect(scope("/api/synthetic-executions?id=pr-1", "acme/other", "aaaa1111")).not.toBe(original);
    expect(scope("/api/synthetic-executions?id=pr-1", "acme/shopfront", "bbbb2222")).not.toBe(original);
  });
});

function renderSandboxEditor(consent: boolean): string {
  return renderToStaticMarkup(
    <SyntheticInputEditor
      scenario={SCENARIO}
      scenarios={[SCENARIO]}
      value={JSON.stringify(SCENARIO.defaultInput)}
      status="idle"
      error={null}
      executionTrust={{
        mode: "sandboxed-pr",
        provenance: { repository: "acme/shopfront", headSha: "abcdef1234567890" },
      }}
      sandboxConsent={consent}
      onChange={vi.fn()}
      onSandboxConsentChange={vi.fn()}
      onScenarioChange={vi.fn()}
      onCancel={vi.fn()}
      onRun={vi.fn()}
    />,
  );
}

function buttonTag(markup: string, label: string): string {
  return markup.match(new RegExp(`<button[^>]*>\\s*${label}\\s*</button>`))?.[0] ?? "";
}

function renderControls(options: {
  rootId?: string;
  endpoint?: string | null;
  mode?: "graph" | "metro" | "blocks" | "timeline";
} = {}): string {
  const store = createBlueprintStore({
    artifact: ARTIFACT,
    index: buildGraphIndex(ARTIFACT),
    provider: null,
    hasOverlay: false,
    sourceUrl: null,
    syntheticExecutionUrl: options.endpoint === undefined ? "/api/synthetic-executions" : options.endpoint,
    syntheticExecutionTrust: options.endpoint === null ? null : { mode: "local" },
    syntheticScenarios: [SCENARIO],
    prsUrl: "",
    prOneUrl: "",
    prFilesUrl: "",
    prRelatedUrl: "",
    prCommentsUrl: "",
    prChecksUrl: "",
    prReviewUrl: "",
  });
  store.setState({ logicView: options.mode ?? "graph" });
  Object.assign(store, { getInitialState: () => store.getState() });
  return renderToStaticMarkup(
    <StoreProvider store={store}>
      <LogicViewTabs rootId={options.rootId ?? ROOT} />
    </StoreProvider>,
  );
}
