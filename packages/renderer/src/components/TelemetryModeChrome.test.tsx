import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import type { BlueprintState } from "../state/store";
import type { TelemetrySourceDescriptor } from "../telemetry/provider";
import { freshStore } from "../parity/surfaceFixture";
import { StoreProvider } from "../state/StoreContext";
import { Toolbar } from "./Toolbar";
import { OverlaysSection } from "./controlpanel/OverlaysSection";
import { LogicViewTabs } from "./logicviews/LogicViewTabs";

interface CapturedPill {
  active: boolean;
  label: string;
  onClick(): void;
}

const capturedPills = vi.hoisted(() => [] as CapturedPill[]);

vi.mock("@xyflow/react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@xyflow/react")>();
  return {
    ...actual,
    Panel: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  };
});

vi.mock("./controlpanel/panelKit", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./controlpanel/panelKit")>();
  return {
    ...actual,
    Pill: (props: { active: boolean; children?: ReactNode; onClick(): void }) => {
      const label = typeof props.children === "string" ? props.children : "";
      capturedPills.push({ active: props.active, label, onClick: props.onClick });
      return (
        <button type="button" aria-pressed={props.active} onClick={props.onClick}>
          {props.children}
        </button>
      );
    },
  };
});

const SOURCE: TelemetrySourceDescriptor = {
  id: "synthetic-demo",
  kind: "mock",
  label: "Synthetic demo",
  provenance: "synthetic",
  environments: ["demo"],
  supportsMetrics: true,
  supportsTraces: true,
};

describe("telemetry mode chrome", () => {
  it("offers the Telemetry pill only when the session advertises telemetry", () => {
    const unavailable = renderWithStore(
      telemetryStore({ telemetryMode: false, telemetrySources: [] }),
      <OverlaysSection />,
    );
    expect(unavailable).not.toContain(">Telemetry</button>");

    const available = renderWithStore(
      telemetryStore({ telemetryMode: false, telemetrySources: [SOURCE] }),
      <OverlaysSection />,
    );
    expect(available).toContain(">Telemetry</button>");
  });

  it("routes the Telemetry pill through the store toggle", () => {
    const store = telemetryStore({ telemetryMode: false, telemetrySources: [SOURCE] });
    capturedPills.length = 0;
    renderWithStore(store, <OverlaysSection />);

    const pill = capturedPills.find((candidate) => candidate.label === "Telemetry");
    expect(pill).toMatchObject({ active: false, label: "Telemetry" });

    pill!.onClick();
    expect(store.getState().telemetryMode).toBe(true);

    pill!.onClick();
    expect(store.getState().telemetryMode).toBe(false);
  });

  it("keeps Request data out of the Toolbar until telemetry mode is active", () => {
    const store = telemetryStore({ telemetryMode: false, telemetrySources: [SOURCE] });
    expect(renderWithStore(store, <Toolbar preselectedEnv={null} />)).not.toContain('aria-label="Request data"');

    store.setState({ telemetryMode: true });
    const active = renderWithStore(store, <Toolbar preselectedEnv={null} />);
    expect(active).toContain('aria-label="Request data"');
    expect(active).toContain('aria-label="Request data source"');
  });

  it("adds Request trace to the Logic tabs only while telemetry mode is active", () => {
    const store = telemetryStore({ telemetryMode: false, telemetrySources: [SOURCE] });
    const inactive = renderWithStore(store, <LogicViewTabs />);
    expect(inactive).toContain("Exec graph");
    expect(inactive).not.toContain("Request trace");

    store.setState({ telemetryMode: true });
    const active = renderWithStore(store, <LogicViewTabs />);
    expect(active).toContain("Exec graph");
    expect(active).toContain("Request trace");
  });
});

function telemetryStore(overrides: Partial<BlueprintState>) {
  const store = freshStore();
  store.setState(overrides);
  return store;
}

function renderWithStore(store: ReturnType<typeof freshStore>, child: ReactNode): string {
  const getInitialState = store.getInitialState;
  store.getInitialState = store.getState;
  try {
    return renderToStaticMarkup(<StoreProvider store={store}>{child}</StoreProvider>);
  } finally {
    store.getInitialState = getInitialState;
  }
}
