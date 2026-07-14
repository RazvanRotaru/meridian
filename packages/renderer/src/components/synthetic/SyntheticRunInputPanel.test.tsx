import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { SyntheticScenarioDescriptor } from "@meridian/core";
import {
  isSyntheticRunShortcut,
  SyntheticRunInputPanel,
  syntheticRunInputState,
} from "./SyntheticRunInputPanel";

const SCENARIO: SyntheticScenarioDescriptor = {
  id: "place-order",
  label: "Place order — priced and persisted",
  rootId: "ts:src/orderService.ts#placeOrder",
  defaultInput: { request: { customerId: "customer_1", discountCode: null } },
};
const ALTERNATE: SyntheticScenarioDescriptor = {
  ...SCENARIO,
  id: "place-order-timeout",
  label: "Place order — repository timeout",
};

describe("SyntheticRunInputPanel", () => {
  it("shows the exact whole-flow input, current-run status, actions, trust note, and accessible label", () => {
    const markup = renderPanel(JSON.stringify(SCENARIO.defaultInput, null, 2));

    expect(markup).toContain('aria-label="Synthetic flow input"');
    expect(markup).toContain('data-input-state="current"');
    expect(markup).toContain("CURRENT RUN");
    expect(markup).toContain("Argument passed to placeOrder");
    expect(markup).toContain('aria-label="Flow input JSON passed to placeOrder"');
    expect(markup).toContain("customerId");
    expect(markup).toContain("Reset to current run");
    expect(buttonTag(markup, "Reset to current run")).toContain("disabled");
    expect(markup).toContain("Run again");
    expect(markup).toContain("Runs trusted local project code on this machine.");
  });

  it("marks semantic edits modified without treating whitespace or property order as changes", () => {
    const modified = renderPanel(JSON.stringify({ request: { customerId: "customer_2", discountCode: null } }, null, 2));
    const reordered = JSON.stringify({ request: { discountCode: null, customerId: "customer_1" } });

    expect(modified).toContain('data-input-state="modified"');
    expect(modified).toContain("MODIFIED");
    expect(modified).toContain("Run changed input");
    expect(buttonTag(modified, "Reset to current run")).not.toContain("disabled");
    expect(syntheticRunInputState(`  ${reordered}\n`, SCENARIO.defaultInput)).toBe("current");
  });

  it("renders immediate invalid JSON feedback and disables execution", () => {
    const markup = renderPanel('{ "request": ');

    expect(markup).toContain('data-input-state="invalid"');
    expect(markup).toContain("INVALID");
    expect(markup).toContain('aria-invalid="true"');
    expect(markup).toContain('role="alert"');
    expect(markup).toContain("Input must be valid JSON.");
    expect(buttonTag(markup, "Run again")).toContain("disabled");
  });

  it("offers a scenario selector only when multiple advertised scenarios are available", () => {
    const pair = renderPanel(JSON.stringify(SCENARIO.defaultInput), [SCENARIO, ALTERNATE]);
    const single = renderPanel(JSON.stringify(SCENARIO.defaultInput), [SCENARIO]);

    expect(pair).toContain('aria-label="Synthetic rerun scenario"');
    expect(pair).toContain("Place order — repository timeout");
    expect(single).not.toContain('aria-label="Synthetic rerun scenario"');
    expect(single).toContain("Place order — priced and persisted");
  });

  it("disables editing and both actions while the rerun is in flight", () => {
    const markup = renderPanel(JSON.stringify({ request: { customerId: "changed" } }), [SCENARIO], "running");

    expect(markup).toContain('aria-busy="true"');
    expect(markup).toContain("Running…");
    expect(markup).toContain('role="status"');
    expect(markup).toContain("Running flow…");
    expect(buttonTag(markup, "Reset to current run")).toContain("disabled");
    expect(buttonTag(markup, "Running…")).toContain("disabled");
  });

  it("makes sandbox consent explicit and gates every rerun editor", () => {
    const unconfirmed = renderPanel(JSON.stringify(SCENARIO.defaultInput), [SCENARIO], "ready", "sandboxed-pr", false);
    const confirmed = renderPanel(JSON.stringify(SCENARIO.defaultInput), [SCENARIO], "ready", "sandboxed-pr", true);

    expect(unconfirmed).toContain("UNTRUSTED PR SANDBOX");
    expect(unconfirmed).toContain("ephemeral OCI");
    expect(unconfirmed).toContain("network disabled");
    expect(unconfirmed).toContain("read-only source");
    expect(unconfirmed).toContain("no host credentials or writable workspace mounts");
    expect(unconfirmed).toContain("I understand this runs untrusted PR code in the isolated sandbox.");
    expect(buttonTag(unconfirmed, "Run again")).toContain("disabled");
    expect(buttonTag(confirmed, "Run again")).not.toContain("disabled");
  });
});

describe("synthetic rerun input helpers", () => {
  it("distinguishes current, modified, and invalid JSON structurally", () => {
    expect(syntheticRunInputState('{"second":[true],"first":1}', { first: 1, second: [true] })).toBe("current");
    expect(syntheticRunInputState('{"first":2,"second":[true]}', { first: 1, second: [true] })).toBe("modified");
    expect(syntheticRunInputState("not JSON", { first: 1 })).toBe("invalid");
  });

  it("recognizes Ctrl/Meta+Enter but not ordinary typing", () => {
    expect(isSyntheticRunShortcut({ key: "Enter", ctrlKey: true, metaKey: false })).toBe(true);
    expect(isSyntheticRunShortcut({ key: "Enter", ctrlKey: false, metaKey: true })).toBe(true);
    expect(isSyntheticRunShortcut({ key: "Enter", ctrlKey: false, metaKey: false })).toBe(false);
    expect(isSyntheticRunShortcut({ key: "r", ctrlKey: true, metaKey: false })).toBe(false);
  });
});

function renderPanel(
  value: string,
  scenarios: readonly SyntheticScenarioDescriptor[] = [SCENARIO],
  status: "idle" | "running" | "ready" | "error" = "ready",
  mode: "local" | "sandboxed-pr" = "local",
  sandboxConsent = false,
): string {
  return renderToStaticMarkup(
    <SyntheticRunInputPanel
      rootLabel="placeOrder"
      scenario={SCENARIO}
      scenarios={scenarios}
      value={value}
      currentInput={SCENARIO.defaultInput}
      status={status}
      error={null}
      executionTrust={mode === "sandboxed-pr"
        ? { mode, provenance: { repository: "acme/shopfront", headSha: "abcdef1234567890" } }
        : { mode }}
      sandboxConsent={sandboxConsent}
      onChange={vi.fn()}
      onSandboxConsentChange={vi.fn()}
      onScenarioChange={vi.fn()}
      onReset={vi.fn()}
      onRun={vi.fn()}
    />,
  );
}

function buttonTag(markup: string, label: string): string {
  return markup.match(new RegExp(`<button[^>]*>\\s*${escapeRegExp(label)}\\s*</button>`))?.[0] ?? "";
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
