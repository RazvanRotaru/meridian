import { renderToStaticMarkup } from "react-dom/server";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { computeCoverage, type GraphArtifact, type JsonValue, type TestExecutionCoverage } from "@meridian/core";
import { freshStore } from "../parity/surfaceFixture";
import { StoreProvider } from "../state/StoreContext";
import { CoveragePanel } from "./CoveragePanel";
import { OverlaysSection } from "./controlpanel/OverlaysSection";

vi.mock("@xyflow/react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@xyflow/react")>();
  return {
    ...actual,
    Panel: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  };
});

describe("coverage chrome", () => {
  it("shows aggregate runtime function and branch-path coverage instead of static reachability", () => {
    const store = freshStore();
    const base = store.getState().artifact;
    const artifact = withRuntimeCoverage(base, runtimeCoverage());
    store.setState({
      artifact,
      coverageMode: true,
      // Static data remains in state for graph painting, but must not be presented as Coverage.
      coverage: computeCoverage(artifact.nodes, artifact.edges),
    });

    const overlays = renderWithStore(store, <OverlaysSection />);
    expect(overlays).toContain(">Coverage</span>");
    expect(overlays).toContain("F 40% · B 50%");
    expect(overlays).toContain("Functions: 2/5 hit (40%) · Branch paths: 2/4 hit (50%)");
    expect(overlays).not.toContain(">Reachability</span>");

    const panel = renderWithStore(store, <CoveragePanel />);
    expect(panel).toContain("Runtime coverage");
    expect(panel).toContain("Functions");
    expect(panel).toContain("40%");
    expect(panel).toContain("2/5 hit");
    expect(panel).toContain("Branch paths");
    expect(panel).toContain("50%");
    expect(panel).toContain("2/4 hit");
    expect(panel).not.toContain("Estimated test reachability");
    expect(panel).not.toContain("directly reachable");
    expect(panel).not.toContain("best-covered last");
  });

  it("labels the static fallback as estimated test reachability", () => {
    const store = freshStore();
    const artifact = store.getState().artifact;
    store.setState({ coverageMode: true, coverage: computeCoverage(artifact.nodes, artifact.edges) });

    const overlays = renderWithStore(store, <OverlaysSection />);
    expect(overlays).toContain(">Reachability</span>");
    expect(overlays).toContain("estimated test reachability");
    expect(overlays).not.toContain(">Coverage</span>");

    const panel = renderWithStore(store, <CoveragePanel />);
    expect(panel).toContain("Estimated test reachability");
    expect(panel).toContain("directly reachable");
    expect(panel).toContain("indirectly reachable");
    expect(panel).toContain("not reached");
    expect(panel).not.toContain("Runtime coverage");
    expect(panel).not.toContain("Static coverage");
  });
});

function renderWithStore(store: ReturnType<typeof freshStore>, child: ReactNode): string {
  const getInitialState = store.getInitialState;
  store.getInitialState = store.getState;
  try {
    return renderToStaticMarkup(<StoreProvider store={store}>{child}</StoreProvider>);
  } finally {
    store.getInitialState = getInitialState;
  }
}

function withRuntimeCoverage(artifact: GraphArtifact, runtime: TestExecutionCoverage): GraphArtifact {
  return {
    ...artifact,
    extensions: {
      ...artifact.extensions,
      testExecutionCoverage: runtime as unknown as JsonValue,
    },
  };
}

function runtimeCoverage(): TestExecutionCoverage {
  return {
    version: "1.0.0",
    aggregate: true,
    producer: { inputFormat: "istanbul-coverage-map" },
    files: {
      "app/core/a.ts": {
        functions: [fn(2), fn(1), fn(0), fn(0), fn(0)],
        branches: [{
          type: "if",
          location: span(),
          paths: [path(0, 3), path(1, 0), path(2, 1), path(3, 0)],
        }],
      },
    },
  };
}

function fn(hits: number): TestExecutionCoverage["files"][string]["functions"][number] {
  return { name: "fn", hits, decl: span(), location: span() };
}

function path(
  index: number,
  hits: number,
): TestExecutionCoverage["files"][string]["branches"][number]["paths"][number] {
  return { index, hits, location: span() };
}

function span() {
  return { start: { line: 1, column: 0 }, end: { line: 1, column: 1 } };
}
