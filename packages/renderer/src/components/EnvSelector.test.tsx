import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { freshStore } from "../parity/surfaceFixture";
import { StoreProvider } from "../state/StoreContext";
import type { BlueprintState } from "../state/store";
import type { TelemetryProvider, TelemetrySourceDescriptor } from "../telemetry/provider";
import { EnvSelector } from "./EnvSelector";

const SOURCES: TelemetrySourceDescriptor[] = [{
  id: "synthetic-demo",
  kind: "mock",
  label: "Synthetic demo",
  provenance: "synthetic",
  environments: ["demo"],
  supportsMetrics: true,
  supportsTraces: true,
}];

const PROVIDER: TelemetryProvider = {
  id: "mock",
  requiresEnvironment: true,
  listEnvironments: () => ["demo"],
  fetchMetrics: async () => ({}),
  fetchTraces: async () => { throw new Error("unused in render test"); },
};

describe("EnvSelector", () => {
  it("keeps Request data visible with an explicit Off source", () => {
    const markup = renderSelector({ telemetrySources: [...SOURCES], telemetrySourceId: null, provider: null });

    expect(markup).toContain('aria-label="Request data"');
    expect(markup).toContain('aria-label="Request data source"');
    expect(markup).toContain(">Off</option>");
    expect(markup).toContain("Synthetic demo");
    expect(markup).toContain('disabled="" aria-label="Request data environment"');
    expect(markup).toContain("Select a source to begin.");
  });

  it("visibly prefills a single demo environment without claiming it is loaded", () => {
    const markup = renderSelector({
      telemetrySources: [...SOURCES],
      telemetrySourceId: "synthetic-demo",
      provider: PROVIDER,
      environment: null,
    });

    expect(markup).toContain('<option value="demo" selected="">demo</option>');
    expect(markup).toContain(">Load</button>");
    expect(markup).toContain("Not loaded");
    expect(markup).toContain("Nothing loads automatically.");
    expect(markup).not.toContain("Loaded · demo");
  });

  it("offers Refresh for the explicitly applied environment and surfaces failures", () => {
    const markup = renderSelector({
      telemetrySources: [...SOURCES],
      telemetrySourceId: "synthetic-demo",
      provider: PROVIDER,
      environment: "demo",
      traceError: "collector offline",
    });

    expect(markup).toContain(">Refresh</button>");
    expect(markup).toContain("Loaded · demo");
    expect(markup).toContain('role="alert"');
    expect(markup).toContain("collector offline");
  });

  it("uses a suggestion-backed text field for an arbitrary environment source", () => {
    const source: TelemetrySourceDescriptor = {
      ...SOURCES[0]!,
      environments: ["demo", "qa-west"],
      environmentMode: "arbitrary",
    };
    const markup = renderSelector({
      telemetrySources: [source],
      telemetrySourceId: source.id,
      provider: { ...PROVIDER, listEnvironments: () => source.environments },
      environment: null,
    }, "qa-west");

    expect(markup).toContain('<input');
    expect(markup).toContain('list="meridian-telemetry-environment-suggestions"');
    expect(markup).toContain('value="qa-west"');
    expect(markup).toContain('<datalist id="meridian-telemetry-environment-suggestions"');
  });
});

function renderSelector(state: Partial<BlueprintState>, preselectedEnv: string | null = null): string {
  const store = freshStore();
  store.setState(state);
  const initial = store.getState();
  Object.assign(store, { getInitialState: () => initial });
  return renderToStaticMarkup(
    <StoreProvider store={store}>
      <EnvSelector preselectedEnv={preselectedEnv} />
    </StoreProvider>,
  );
}
