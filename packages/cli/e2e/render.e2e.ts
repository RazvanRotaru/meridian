/**
 * End-to-end: generate the fixture, open it through `meridian web`, and drive a real
 * headless Chromium to prove the blueprint renders, drills down, gates telemetry behind an
 * explicit environment, and refuses to default to prod. Skips cleanly when the Playwright
 * browser is not installed (`npx playwright install chromium`).
 */

import { rmSync } from "node:fs";
import type { ChildProcess } from "node:child_process";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser, type Locator, type Page } from "playwright";
import { chromiumInstalled, generateGraph, runCli, startViewWithoutOverlay } from "./harness";

let graphDir: string | undefined;

afterAll(() => {
  if (graphDir) {
    rmSync(graphDir, { recursive: true, force: true });
  }
});

describe.skipIf(!chromiumInstalled())("rendered blueprint (headless chromium)", () => {
  let server: ChildProcess;
  let browser: Browser;
  let page: Page;
  let viewUrl: string;
  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];

  beforeAll(async () => {
    const generated = generateGraph();
    graphDir = generated.dir;
    const view = await startViewWithoutOverlay(generated.graphPath);
    viewUrl = view.url;
    server = view.server;
    browser = await chromium.launch({ headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
    page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
    page.on("console", (message) => message.type() === "error" && consoleErrors.push(message.text()));
    page.on("pageerror", (error) => pageErrors.push(error.message));
    await page.goto(view.url, { waitUntil: "networkidle" });
    await page.waitForSelector(".react-flow__node");
  });

  afterAll(async () => {
    await browser?.close();
    server?.kill("SIGINT");
  });

  it("renders the Map (package overview) as the default lens, with no console/page errors", async () => {
    // The default "modules" lens is the Map: the whole-repo package overview (group cards).
    expect(await page.locator(".react-flow__node").count()).toBeGreaterThan(0);
    expect(await page.locator('button:has-text("Map")').count()).toBe(1);
    expect(await page.getByRole("region", { name: "Request data" }).count()).toBe(0);
    expect(await page.locator(".request-graph-overlay-panel").count()).toBe(0);
    expect(consoleErrors).toEqual([]);
    expect(pageErrors).toEqual([]);
  });

  it("lets a disconnected PR deep link return to the graph", async () => {
    await page.goto(`${viewUrl}?view=prs`, { waitUntil: "networkidle" });
    expect(await page.getByRole("group", { name: "Canvas actions" }).count()).toBe(0);
    const back = page.getByRole("button", { name: "PR review" });
    await back.waitFor();
    expect(await back.isEnabled()).toBe(true);
    expect(await back.getAttribute("title")).toBe("Back to the graph");

    await back.click();
    await page.waitForSelector(".react-flow__node");
    await page.getByRole("group", { name: "Canvas actions" }).waitFor();
    expect(new URL(page.url()).searchParams.get("view")).toBeNull();
  });

  // Runs before the Service-lens switch below so it starts on the default Map lens.
  it("collapses and restores the detailed controls while keeping the panel summary", async () => {
    const panel = page.locator("#meridian-control-panel");
    const actionBar = page.getByRole("group", { name: "Canvas actions" });
    const controls = page.locator("#meridian-control-panel-controls");
    const prReview = page.getByRole("button", { name: "PR review" });
    const recenter = actionBar.getByRole("button", { name: "Recenter view" });
    const expand = actionBar.getByRole("button", { name: "Expand one level" });
    const collapse = actionBar.getByRole("button", { name: "Collapse all" });
    const repositorySummary = panel.getByText("Repository · 1 package · 11 files", { exact: true });
    const requestData = panel.getByRole("region", { name: "Request data" });
    const unavailableBadge = panel.getByText("Unavailable", { exact: true });
    const disclosure = panel.locator('button[aria-controls="meridian-control-panel-controls"]');
    const expandedHeight = await panel.evaluate((element) => element.getBoundingClientRect().height);

    expect(await prReview.isDisabled()).toBe(true);
    expect(await unavailableBadge.isVisible()).toBe(true);
    expect(await prReview.getAttribute("title")).toBe("PR review needs a GitHub repository. Open one with meridian web <owner/repo>.");
    expect(await disclosure.getAttribute("aria-label")).toBe("Hide detailed controls");
    expect(await disclosure.getAttribute("aria-expanded")).toBe("true");
    expect(await actionBar.isVisible()).toBe(true);
    expect(await recenter.isVisible()).toBe(true);
    expect(await expand.isVisible()).toBe(true);
    expect(await collapse.isVisible()).toBe(true);
    expect(await requestData.count()).toBe(0);
    expect(await panel.getByRole("button", { name: "Recenter view" }).count()).toBe(0);
    await disclosure.click();
    expect(await panel.isVisible()).toBe(true);
    expect(await controls.isHidden()).toBe(true);
    expect(await prReview.isVisible()).toBe(true);
    expect(await actionBar.isVisible()).toBe(true);
    expect(await recenter.isVisible()).toBe(true);
    expect(await repositorySummary.isVisible()).toBe(true);
    expect(await requestData.count()).toBe(0);
    expect(await disclosure.getAttribute("aria-label")).toBe("Show detailed controls");
    expect(await disclosure.getAttribute("aria-expanded")).toBe("false");
    expect(await disclosure.evaluate((element) => document.activeElement === element)).toBe(true);
    expect(await panel.evaluate((element) => element.getBoundingClientRect().height)).toBeLessThan(expandedHeight);

    await disclosure.click();
    expect(await controls.isVisible()).toBe(true);
    expect(await disclosure.getAttribute("aria-label")).toBe("Hide detailed controls");
    expect(await disclosure.getAttribute("aria-expanded")).toBe("true");
    expect(await disclosure.evaluate((element) => document.activeElement === element)).toBe(true);
    expect(await panel.evaluate((element) => element.getBoundingClientRect().height)).toBe(expandedHeight);
  });

  it("keeps the compact action bar clear of canvas chrome at a narrow desktop width", async () => {
    const packageNode = page.locator('[data-id="ts:src"]');
    await packageNode.click();
    const actionBar = page.getByRole("group", { name: "Canvas actions" });
    await actionBar.getByRole("button", { name: "Extract selection (1)" }).waitFor();

    try {
      await page.setViewportSize({ width: 900, height: 600 });
      await actionBar.getByRole("button", { name: "Recenter view" }).click();
      await expectNoOverlap(actionBar, page.locator("#meridian-control-panel"));
      await expectNoOverlap(actionBar, page.getByRole("button", { name: /Legend/ }));
      await expectNoOverlap(actionBar, page.locator(".react-flow__minimap"));
    } finally {
      await page.setViewportSize({ width: 1400, height: 900 });
      await page.locator(".react-flow__pane").dispatchEvent("click");
    }
  });

  it("keeps the Map legend static when selection changes", async () => {
    await page.getByRole("button", { name: /Legend/ }).click();
    const legend = page.getByRole("region", { name: "Map legend" });
    const beforeSelection = await legend.innerText();
    expect(beforeSelection).toContain("WHEN YOU SELECT");

    const packageNode = page.locator('[data-id="ts:src"]');
    await packageNode.click();
    await page.getByRole("group", { name: "Canvas actions" }).getByRole("button", { name: "Extract selection (1)" }).waitFor();
    expect(await legend.innerText()).toBe(beforeSelection);

    await page.locator(".react-flow__pane").dispatchEvent("click");
    await page.getByRole("group", { name: "Canvas actions" }).getByRole("button", { name: "Extract selection (1)" }).waitFor({ state: "detached" });
    expect(await legend.innerText()).toBe(beforeSelection);
    await legend.getByTitle("Close").click();
  });

  it("Service lens renders svc: cluster frames wired by couplings, with no console/page errors", async () => {
    // The composition surface merged into the Lens segmented control. Its root is now an honest
    // hierarchy of artificial domain containers, not a flat wall of `svc:` frames. Synthetic
    // parents must keep the same selection, extraction, expansion, and navigation contracts as
    // every ordinary Map container.
    await lensButton(page, "Service").dispatchEvent("click");
    const domains = page.locator('.react-flow__node-serviceDomain[data-id^="service-domain:"]');
    await expect.poll(() => domains.count(), { timeout: 30_000 }).toBeGreaterThan(1);
    expect(await page.locator('.react-flow__node-package[data-id^="svc:"]').count()).toBe(0);

    // The fixture's otherwise-unassigned service frames grow as showcase source is added. Read the
    // displayed total so the test verifies disclosure parity without baking in fixture cardinality.
    // Selecting their artificial parent still selects exactly one logical node and offers the
    // universal extraction action; the parent does not need a special-case interaction path.
    const domain = page.locator('.react-flow__node-serviceDomain[data-id="service-domain:unassigned"]');
    expect(await domain.count()).toBe(1);
    const unassignedMatch = (await domain.innerText()).match(/(\d+) unassigned groups/);
    expect(unassignedMatch).not.toBeNull();
    const unassignedGroupCount = Number(unassignedMatch?.[1] ?? 0);
    expect(unassignedGroupCount).toBeGreaterThan(0);
    await domain.dispatchEvent("click");
    await page.getByRole("button", { name: "Extract selection (1)", exact: true }).waitFor();
    expect(await page.locator("#meridian-control-panel").getByText("Unassigned code", { exact: true }).count()).toBe(1);

    // Expansion is the explicit chevron action, separate from navigation. It reveals the domain's
    // real `svc:` children in place and preserves their exact structural coupling kind. Calls are
    // abundant in this fixture but intentionally remain a hidden Service overlay by default.
    const expandDomain = domain.getByRole("button", { name: "Expand", exact: true });
    expect(await expandDomain.count()).toBe(1);
    await expandDomain.dispatchEvent("click");
    const serviceFrames = page.locator('.react-flow__node-package[data-id^="svc:"]');
    await expect.poll(() => serviceFrames.count(), { timeout: 30_000 }).toBe(unassignedGroupCount);
    expect(await domain.getByRole("button", { name: "Collapse", exact: true }).count()).toBe(1);

    // One domain action exposes only its direct synthetic `svc:` children. Every frame is still a
    // collapsed container with its own explicit Expand action; no class/unit (or method/block)
    // grandchild may leak through until that frame receives a separate action.
    expect(await serviceFrames.getByRole("button", { name: "Expand", exact: true }).count()).toBe(unassignedGroupCount);
    expect(await page.locator('.react-flow__node-unit[data-id^="ts:"]').count()).toBe(0);
    expect(await page.locator('.react-flow__node-block[data-id^="ts:"]').count()).toBe(0);

    const constructionCouplings = page.locator(
      '.react-flow__edge[data-id^="dep:instantiates:"][aria-label*="svc:"]',
    );
    await expect.poll(() => constructionCouplings.count(), { timeout: 20_000 }).toBeGreaterThan(0);
    expect(await page.locator('.react-flow__edge[data-id^="dep:calls:"]').count()).toBe(0);

    // Double-click is navigation only: the domain becomes the effective focus, its service frames
    // become the current level, and the containment trail records the synthetic parent. Semantic
    // navigation may retain the parent as context, so focus + breadcrumb are the durable contract.
    // Return to the root so later cross-lens tests start from the same neutral surface state.
    await domain.dispatchEvent("dblclick");
    await expect.poll(() => new URL(page.url()).searchParams.get("mfocus"), { timeout: 30_000 })
      .toBe("service-domain:unassigned");
    await expect.poll(() => serviceFrames.count(), { timeout: 30_000 }).toBeGreaterThan(1);
    const containment = page.getByRole("navigation", { name: "Containment level" });
    await containment.getByText("Unassigned code", { exact: true }).waitFor({ timeout: 30_000 });
    await containment.getByRole("button", { name: "All services", exact: true }).dispatchEvent("click");
    await domain.waitFor();
    expect(consoleErrors).toEqual([]);
    expect(pageErrors).toEqual([]);
  });

  it("maps the selected request onto graph cards and proven execution wires after an explicit load", async () => {
    const telemetryMode = page
      .getByRole("group", { name: "Overlays" })
      .getByRole("button", { name: "Telemetry", exact: true });
    expect(await telemetryMode.getAttribute("aria-pressed")).toBe("false");
    await telemetryMode.click();
    expect(await telemetryMode.getAttribute("aria-pressed")).toBe("true");

    const requestData = requestDataRegion(page);
    await requestData.waitFor();
    const source = requestData.getByLabel("Request data source");
    const environment = requestData.getByLabel("Request data environment");
    expect(await source.inputValue()).toBe("");
    expect(await environment.isDisabled()).toBe(true);
    expect(await statusText(page)).toBe("Not loaded");

    await selectAndLoadDemo(page, "Request data");
    expect(await statusText(page)).toBe("Loaded · demo");

    const requestOverlay = page.getByRole("region", { name: "Selected request graph overlay" });
    await requestOverlay.waitFor({ timeout: 30_000 });
    const requestSelector = requestOverlay.getByLabel("Request shown on map");
    expect(await requestSelector.locator("option").count()).toBeGreaterThanOrEqual(10);
    await requestSelector.selectOption("11111111111111111111111111111111");
    expect(await requestOverlay.getByText("POST /orders — WELCOME10", { exact: true }).count()).toBe(1);
    // Explicit adjacent controls make a capture set browsable without reopening the dropdown.
    // They wrap at both ends, so oldest → next → previous lands on the same canonical request.
    await requestOverlay.getByRole("button", { name: "Next request" }).click();
    await expect.poll(() => requestSelector.inputValue()).not.toBe("11111111111111111111111111111111");
    await requestOverlay.getByRole("button", { name: "Previous request" }).click();
    await expect.poll(() => requestSelector.inputValue()).toBe("11111111111111111111111111111111");
    await expect.poll(() => page.locator('[data-request-observed="true"]:visible').count(), { timeout: 20_000 }).toBeGreaterThan(0);

    // The split belongs to the selected request, not a graph click. It reconstructs the concrete
    // success path (including the success-only notification) from span/event occurrences.
    await requestOverlay.getByRole("button", { name: "Show selected request logic flow" }).click();
    const requestFlow = page.getByRole("complementary", { name: "Selected request logic flow" });
    await requestFlow.waitFor({ timeout: 30_000 });
    await requestFlow.getByText("sendOrderConfirmation", { exact: true }).waitFor();
    expect(await requestFlow.getByText("RepositoryTimeout", { exact: false }).count()).toBe(0);
    const observedRequestEdges = requestFlow.locator(
      '.request-flow-edge--observed[data-request-flow-evidence="observed"]',
    );
    const staticContextEdges = requestFlow.locator(
      '.request-flow-edge--context[data-request-flow-evidence="context"]',
    );
    await expect.poll(() => observedRequestEdges.count()).toBeGreaterThan(0);
    const collapsedObservedEdgeCount = await observedRequestEdges.count();
    expect(await staticContextEdges.count()).toBe(0);
    // Every flow-backed occurrence starts collapsed. Opening this exact occurrence grafts the same
    // static structure as Exec graph: two decision diamonds plus its default-expanded loop.
    const validateOccurrenceId = "request:11111111111111111111111111111111:span:1000000000000003";
    const validateOccurrence = requestFlow.locator(`.react-flow__node[data-id="${validateOccurrenceId}"]`);
    expect(await validateOccurrence.count()).toBe(1);
    expect(await requestFlow.locator(`.react-flow__node[data-id^="${validateOccurrenceId}:exec::"]`).count()).toBe(0);
    await validateOccurrence.getByRole("button", { name: "expand in place" }).click();
    for (const suffix of [":exec::p0/0", ":exec::p0/1", ":exec::p0/2", ":exec::p0/2/p0/0"]) {
      await requestFlow.locator(`.react-flow__node[data-id="${validateOccurrenceId}${suffix}"]`).waitFor();
    }
    await expect.poll(() => staticContextEdges.count()).toBeGreaterThan(0);
    expect(await observedRequestEdges.count()).toBeGreaterThan(collapsedObservedEdgeCount);
    expect(await requestFlow.locator(
      '.request-flow-edge--observed[data-request-flow-basis="branch-path"][data-request-flow-site-id="validate:customer"][data-request-flow-path-ids="else"]',
    ).count()).toBe(1);
    expect(await requestFlow.locator(
      '.request-flow-edge--observed[data-request-flow-basis="branch-path"][data-request-flow-site-id="validate:lines"][data-request-flow-path-ids="else"]',
    ).count()).toBe(1);
    await requestFlow.getByText("assertLineIsSane", { exact: true }).waitFor();
    for (const absorbedEventId of ["s-customer", "s-lines", "s-lines-loop"]) {
      expect(await requestFlow.locator(`.react-flow__node[data-id="request:11111111111111111111111111111111:event:1000000000000003:${absorbedEventId}"]`).count()).toBe(0);
    }
    await validateOccurrence.getByRole("button", { name: "collapse" }).click();
    await expect.poll(() => requestFlow.locator(`.react-flow__node[data-id^="${validateOccurrenceId}:exec::"]`).count()).toBe(0);
    await expect.poll(() => staticContextEdges.count()).toBe(0);
    await expect.poll(() => observedRequestEdges.count()).toBe(collapsedObservedEdgeCount);

    // A second, non-control example proves expansion is capability-driven rather than tailored to
    // validateOrderRequest. Pricing has a normal call sequence and receives the same affordance.
    const priceOccurrenceId = "request:11111111111111111111111111111111:span:1000000000000004";
    const priceOccurrence = requestFlow.locator(`.react-flow__node[data-id="${priceOccurrenceId}"]`);
    expect(await priceOccurrence.count()).toBe(1);
    await priceOccurrence.getByRole("button", { name: "expand in place" }).click();
    await requestFlow.locator(`.react-flow__node[data-id="${priceOccurrenceId}:exec::p0/0"]`).waitFor();
    await expect.poll(() => observedRequestEdges.count()).toBeGreaterThan(collapsedObservedEdgeCount);
    expect(await requestFlow.locator(
      '.request-flow-edge--observed[data-request-flow-basis="span-body"][data-request-flow-span-id="1000000000000004"]',
    ).count()).toBe(3);
    expect(await staticContextEdges.count()).toBe(0);
    await priceOccurrence.getByRole("button", { name: "collapse" }).click();
    const rootNodeId = "ts:src/api/orderRoutes.ts#OrderRoutes.handleCreateOrder";
    const rootRuntimeOccurrence = requestFlow.locator(
      `[data-request-runtime-kind="span"][data-request-runtime-target="${rootNodeId}"]`,
    );
    expect(await rootRuntimeOccurrence.count()).toBe(1);
    await rootRuntimeOccurrence.click();
    await page.waitForSelector(`.react-flow__node[data-id="${rootNodeId}"]`, { timeout: 30_000 });
    await requestOverlay.getByText("SELECTED OBSERVED · OrderRoutes.handleCreateOrder", { exact: true }).waitFor();

    // The explicit reveal reuses the codebase LCA projection: it opens only the ancestor paths
    // needed to draw every exact observed callable, then fits the Map to that set.
    const exactObservedIds = [
      rootNodeId,
      "ts:src/services/orderService.ts#OrderService.placeOrder",
      "ts:src/validation/orderValidator.ts#validateOrderRequest",
      "ts:src/pricing/pricingService.ts#PricingService.price",
      "ts:src/services/orderService.ts#OrderService.assemble",
      "ts:src/repository/orderRepository.ts#OrderRepository.save",
      "ts:src/notifications/emailService.ts#EmailService.sendOrderConfirmation",
    ];
    await requestOverlay.getByRole("button", { name: "Reveal observed nodes (7)" }).click();
    for (const id of exactObservedIds) {
      await page.waitForSelector(`.react-flow__node[data-id="${id}"]`, { timeout: 30_000 });
      expect(await page.locator(`.react-flow__node[data-id="${id}"]`).getAttribute("data-request-observed")).toBe("true");
    }
    await expect.poll(() => page.locator(".request-graph-edge--observed:visible").count(), { timeout: 20_000 }).toBeGreaterThan(0);
    await page.locator('.react-flow__node[data-id="ts:src/services/orderService.ts#OrderService.placeOrder"]').click();
    await page.waitForTimeout(350);
    expect(await requestFlow.isVisible()).toBe(true);
    expect(await requestFlow.getByText("sendOrderConfirmation", { exact: true }).count()).toBe(1);

    // Nested expansion uses the same source/path contract. This request reaches two implicit
    // fallthroughs inside assertLineIsSane before taking the negative-price throw arm.
    const negativePriceTraceId = "0000000000000000000000000000000c";
    const negativePriceValidateSpanId = "000c000000000003";
    const negativePriceValidateOccurrenceId = `request:${negativePriceTraceId}:span:${negativePriceValidateSpanId}`;
    await requestSelector.selectOption(negativePriceTraceId);
    await requestFlow.getByLabel("Selected request context")
      .getByText("POST /orders — negative price", { exact: true })
      .waitFor();
    const negativePriceValidate = requestFlow.locator(
      `.react-flow__node[data-id="${negativePriceValidateOccurrenceId}"]`,
    );
    await negativePriceValidate.getByRole("button", { name: "expand in place" }).click();
    const assertLineOccurrenceId = `${negativePriceValidateOccurrenceId}:exec::p0/2/p0/0`;
    const assertLineOccurrence = requestFlow.locator(
      `.react-flow__node[data-id="${assertLineOccurrenceId}"]`,
    );
    await assertLineOccurrence.waitFor();
    await assertLineOccurrence.getByRole("button", { name: "expand in place" }).click();
    await requestFlow.locator(`.react-flow__node[data-id="${assertLineOccurrenceId}/0"]`).waitFor();
    expect(await requestFlow.locator(
      '.request-flow-edge--observed[data-request-flow-basis="branch-path"][data-request-flow-site-id="validate:sku"][data-request-flow-path-ids="else"]',
    ).count()).toBe(1);
    expect(await requestFlow.locator(
      '.request-flow-edge--observed[data-request-flow-basis="branch-path"][data-request-flow-site-id="validate:quantity"][data-request-flow-path-ids="else"]',
    ).count()).toBe(1);
    expect(await requestFlow.locator(
      '.request-flow-edge--observed[data-request-flow-basis="branch-path"][data-request-flow-site-id="validate:price"][data-request-flow-path-ids="then"]',
    ).count()).toBe(2);

    // The rejected request removes the success-only branches from the graph while leaving the
    // request panel and ordinary graph selection independent. The already-open split switches in
    // place to the newly selected request rather than keeping or reopening a clicked-node flow.
    await requestSelector.selectOption("22222222222222222222222222222222");
    await requestOverlay.getByText("POST /orders — missing customer", { exact: true }).waitFor();
    await requestFlow.getByLabel("Selected request context")
      .getByText("POST /orders — missing customer", { exact: true })
      .waitFor();
    await expect.poll(() => requestFlow.getByText("sendOrderConfirmation", { exact: true }).count()).toBe(0);
    await expect.poll(() => requestFlow.getByText("price", { exact: true }).count()).toBe(0);
    expect(await requestFlow.getByText("toErrorResponse", { exact: true }).count()).toBe(1);
    for (const id of [
      "ts:src/pricing/pricingService.ts#PricingService.price",
      "ts:src/repository/orderRepository.ts#OrderRepository.save",
      "ts:src/notifications/emailService.ts#EmailService.sendOrderConfirmation",
    ]) {
      await expect.poll(() => page.locator(`.react-flow__node[data-id="${id}"]`).getAttribute("data-request-observed"), { timeout: 20_000 }).toBe("false");
    }
    expect(await page.locator('.react-flow__node[data-id="ts:src/api/orderRoutes.ts#OrderRoutes.handleCreateOrder"]').getAttribute("data-request-observed")).toBe("true");
    const unobservedPrice = page.locator('.react-flow__node[data-id="ts:src/pricing/pricingService.ts#PricingService.price"]');
    await unobservedPrice.click();
    await expect.poll(() => unobservedPrice.getAttribute("data-request-manual-context"), { timeout: 20_000 }).toBe("true");
    expect(await unobservedPrice.getAttribute("data-request-observed")).toBe("false");

    // Leaving telemetry mode removes every request-only widget and all runtime paint, but keeps the
    // loaded bundle resident. Re-entering restores the same selected request without another load.
    await telemetryMode.click();
    await expect.poll(() => telemetryMode.getAttribute("aria-pressed")).toBe("false");
    await expect.poll(() => requestDataRegion(page).count()).toBe(0);
    await expect.poll(() => requestOverlay.count()).toBe(0);
    await expect.poll(() => page.locator('[data-request-observed]').count()).toBe(0);
    await expect.poll(() => requestFlow.count()).toBe(0);

    await telemetryMode.click();
    await expect.poll(() => telemetryMode.getAttribute("aria-pressed")).toBe("true");
    await requestDataRegion(page).waitFor();
    expect(await statusText(page)).toBe("Loaded · demo");
    await page.getByRole("region", { name: "Selected request graph overlay" }).waitFor();
  });

  it("renders and switches a synthetic request timeline with inspectable branch evidence", async () => {
    const root = "ts:src/api/orderRoutes.ts#OrderRoutes.handleCreateOrder";
    const requestUrl = new URL(viewUrl);
    requestUrl.searchParams.set("view", "logic");
    requestUrl.searchParams.set("lroot", root);
    requestUrl.searchParams.set("lstack", root);
    requestUrl.searchParams.set("lview", "request");
    await page.goto(requestUrl.toString(), { waitUntil: "networkidle" });
    const telemetryMode = page
      .getByRole("group", { name: "Overlays" })
      .getByRole("button", { name: "Telemetry", exact: true });
    await telemetryMode.waitFor();
    expect(await telemetryMode.getAttribute("aria-pressed")).toBe("true");

    // Regression: the alternate-Logic canvas reserves left toolbar headroom. Its former fixed
    // 1060px empty state centered this picker completely beyond a narrow in-app browser pane.
    await page.setViewportSize({ width: 585, height: 900 });
    try {
      const requestData = requestDataRegion(page);
      await requestData.waitFor();
      const setupBox = await requestData.boundingBox();
      expect(setupBox).not.toBeNull();
      expect(setupBox!.x).toBeGreaterThanOrEqual(0);
      expect(setupBox!.x + setupBox!.width).toBeLessThanOrEqual(585);
      await selectAndLoadDemo(page, "Request data");
    } finally {
      await page.setViewportSize({ width: 1400, height: 900 });
    }

    const timeline = page.getByRole("region", { name: "Request trace timeline" });
    await timeline.waitFor({ timeout: 30_000 });
    const requestSelector = timeline.getByLabel("Request trace selection", { exact: true });
    expect(await requestSelector.count()).toBe(1);
    await requestSelector.selectOption("11111111111111111111111111111111");
    await timeline.getByText("POST /orders — WELCOME10", { exact: true }).waitFor();
    expect(await timeline.getByText("SYNTHETIC DEMO", { exact: false }).count()).toBeGreaterThan(0);
    expect(await timeline.getByText("PricingService.price", { exact: true }).count()).toBe(1);

    await timeline.getByRole("button", { name: /!code \|\| !isKnownCode\(code\).*false/ }).click();
    await timeline.getByText("GENERATED PROBE PREVIEW", { exact: true }).waitFor();
    expect(await timeline.getByText("request.discountCode", { exact: true }).count()).toBe(1);
    expect(await timeline.getByText("src/pricing/pricingService.ts:28", { exact: true }).count()).toBe(1);

    await requestSelector.selectOption("22222222222222222222222222222222");
    await timeline.getByText("POST /orders — missing customer", { exact: true }).waitFor();
    expect(await timeline.getByText("OrderRoutes.toErrorResponse", { exact: true }).count()).toBe(1);
    expect(await timeline.getByText("PricingService.price", { exact: true }).count()).toBe(0);
    expect(consoleErrors).toEqual([]);
    expect(pageErrors).toEqual([]);

    // This suite shares one page across tests. Return to the default Map so the deep-linked Logic
    // root/sub-view cannot leak into the older lens/coverage scenarios below.
    await page.goto(viewUrl, { waitUntil: "networkidle" });
    await page.waitForSelector(".react-flow__node");
  });

  it("hides tests by default on the Map, and the badged Tests pill reveals then re-hides them", async () => {
    // Back to the Map lens, then drill into src — the level where __tests__ would be drawn
    // (testIds close over containment, so the group card itself is hidden with its files).
    await lensButton(page, "Map").dispatchEvent("click");
    await page.waitForSelector('[data-id="ts:src"]', { timeout: 30_000 });
    await page.locator('[data-id="ts:src"]').dispatchEvent("dblclick");
    await page.waitForSelector('[data-id="ts:src/services"]', { timeout: 30_000 });
    // showTests DEFAULTS to false: no test cards at boot.
    expect(await page.locator('[data-id="ts:src/__tests__"]').count()).toBe(0);
    // The Tests pill carries its file-count badge; clicking it SHOWS the test cards…
    const testsPill = page.getByRole("button", { name: /^Tests \d+$/ });
    expect(await testsPill.count()).toBe(1);
    await testsPill.dispatchEvent("click");
    await page.waitForSelector('[data-id="ts:src/__tests__"]', { timeout: 30_000 });
    // …and clicking again hides them in place (filtered, not permanently pruned).
    await testsPill.dispatchEvent("click");
    await expect.poll(() => page.locator('[data-id="ts:src/__tests__"]').count(), { timeout: 20_000 }).toBe(0);
  });

  it("reachability mode opens the estimated panel with verdicts, reasons, and the summary percentage", async () => {
    await page.click('button:has-text("Reachability")');
    await page.waitForSelector("text=Estimated test reachability");
    const panel = await page.locator("text=Estimated test reachability").locator("xpath=ancestor::div[1]").innerText();
    expect(panel).toMatch(/\d+%/);
    await page.waitForSelector("text=not reached");
    await page.waitForSelector("text=OrderRoutes");
    await page.waitForSelector("text=/never called in the graph/");
    expect(consoleErrors).toEqual([]);
    expect(pageErrors).toEqual([]);
  });
});

describe("never-prod gate", () => {
  it("refuses --overlay without --env (exit code 2)", () => {
    const { graphPath, dir } = generateGraph();
    graphDir = dir;
    const result = runCli(["web", graphPath, "--overlay", "mock", "--no-open"]);
    expect(result.code).toBe(2);
    expect(result.stderr).toMatch(/never defaults/i);
  });
});

function statusText(page: Page, regionName = "Request data"): Promise<string> {
  return requestDataRegion(page, regionName).getByRole("status").innerText();
}

function requestDataRegion(page: Page, name = "Request data"): Locator {
  return page.getByRole("region", { name });
}

async function selectAndLoadDemo(page: Page, setupRegionName: string): Promise<void> {
  const requestData = requestDataRegion(page, setupRegionName);
  const source = requestData.getByLabel("Request data source");
  const environment = requestData.getByLabel("Request data environment");
  await source.selectOption("demo");
  expect(await source.locator("option:checked").innerText()).toBe("Synthetic demo");
  await expect.poll(() => environment.inputValue()).toBe("demo");
  expect(await statusText(page, setupRegionName)).toBe("Not loaded");
  await requestData.getByRole("button", { name: "Load", exact: true }).click();
  await expect.poll(() => statusText(page), { timeout: 30_000 }).toBe("Loaded · demo");
}

/** A lens segment button inside the Lens segmented control (ViewModeToggle). */
function lensButton(page: Page, label: string): Locator {
  return page.getByLabel("Lens").getByRole("button", { name: label, exact: true });
}

async function expectNoOverlap(first: Locator, second: Locator): Promise<void> {
  const [a, b] = await Promise.all([first.boundingBox(), second.boundingBox()]);
  expect(a).not.toBeNull();
  expect(b).not.toBeNull();
  if (!a || !b) {
    return;
  }
  const overlaps = a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
  expect(overlaps).toBe(false);
}
