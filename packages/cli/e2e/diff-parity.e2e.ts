/**
 * Browser contract for a trustworthy code diff. Four real local PR refs travel through the same
 * GitHub proxy, smart-HTTP clone, merge-base extraction, hover preview, and </> modal as production.
 * Every assertion is scoped to one exact file path. The rendered rows must independently equal
 * both that file's GitHub-style U3 patch and a raw `git diff -U0` merge-base oracle.
 */

import { rmSync } from "node:fs";
import type { Server } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { chromium, type Browser, type BrowserContext, type Locator, type Page } from "playwright";
import {
  buildNodeId,
  changedFileManifestFromExtensions,
  type ChangedFileManifestEntry,
  type GraphArtifact,
} from "@meridian/core";
import { createWebServer } from "../src/server/web-server";
import {
  DIFF_PARITY_CASES,
  buildDiffParityFixture,
  type DiffParityCaseSpec,
  type DiffParityFile,
  type DiffParityFixture,
  type DiffParityPr,
  type ExpectedDiffRow,
  type ExpectedSourceRow,
} from "./diff-parity-fixture";
import {
  RENDERER_INDEX,
  chromiumInstalled,
  ensureBuilt,
  listenServer,
  nodeHeader,
  startSmartGitServer,
  verifySmartHttpRemote,
} from "./harness";

const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const WEB_UI = fileURLToPath(new URL("../web-ui/index.html", import.meta.url));
const nativeFetch = globalThis.fetch.bind(globalThis);
const HAS_CHROMIUM = chromiumInstalled();

if (process.env.CI && !HAS_CHROMIUM) {
  throw new Error("canonical diff parity requires Chromium in CI; run the workflow's Playwright install step");
}

let fixture: DiffParityFixture | undefined;
let smartGitServer: Server | undefined;
let webServer: Server | undefined;
let browser: Browser | undefined;
let viewUrl = "";
let restoreGitRedirect: (() => void) | undefined;
const unexpectedGitHubRequests: string[] = [];

type PrAnalysisProgressStage = "clone" | "checkout" | "extract";

interface PrAnalysisProgress {
  stage: PrAnalysisProgressStage;
}

interface PrAnalysisDone {
  stage: "done";
  graphId: string;
  comparisonGraphId: string;
  headSha: string;
  mergeBaseSha: string;
  counts: { nodes: number; edges: number };
  changedFiles: ChangedFileManifestEntry[];
  warnings: string[];
  cache: "hit" | "miss";
}

type PrAnalysisRecord = PrAnalysisProgress | PrAnalysisDone;

describe.skipIf(!HAS_CHROMIUM)("same-file GitHub/Git code diff parity (headless chromium)", () => {
  beforeAll(setup, 240_000);
  afterAll(teardown);

  for (const spec of DIFF_PARITY_CASES) {
    it(`PR #${spec.number} ${spec.targetPath}: ${spec.label}`, async () => {
      const pr = fixture?.prs.find((candidate) => candidate.number === spec.number);
      if (!pr || !browser) throw new Error(`diff parity fixture PR #${spec.number} was not initialized`);
      const context = await browser.newContext({ viewport: { width: 1500, height: 950 } });
      try {
        await assertPrDiff(context, pr, spec);
      } finally {
        await context.close();
      }
    }, 240_000);
  }
});

async function setup(): Promise<void> {
  unexpectedGitHubRequests.length = 0;
  ensureBuilt();
  fixture = buildDiffParityFixture();
  const smartGit = await startSmartGitServer(fixture);
  smartGitServer = smartGit.server;
  await verifySmartHttpRemote(smartGit.repoUrl);
  restoreGitRedirect = installGitRedirect(smartGit.repoUrl);
  vi.stubGlobal("fetch", fakeGitHub(fixture));
  const cacheRoot = join(fixture.dir, "cache");
  const statusPr = fixture.prs.find((candidate) => candidate.number === 34);
  const statusSpec = DIFF_PARITY_CASES.find((candidate) => candidate.number === 34);
  if (!statusPr?.expectedCanonicalManifest) throw new Error("diff parity fixture PR #34 has no canonical manifest");
  if (!statusSpec?.addedFile || !statusSpec.deletedNode) throw new Error("diff parity case PR #34 has no status-specific nodes");

  const cold = await startMeridian(cacheRoot);
  webServer = cold.server;
  const coldAnalysis = await analyzePr(cold.baseUrl, cold.sessionId, statusPr);
  expect(coldAnalysis.map((record) => record.stage), "cold PR analysis must stream every real work stage").toEqual([
    "clone",
    "checkout",
    "extract",
    "done",
  ]);
  const coldDone = terminalAnalysis(coldAnalysis);
  expect(coldDone.cache).toBe("miss");
  expect(coldDone.headSha).toBe(statusPr.headSha);
  expect(coldDone.mergeBaseSha).toBe(statusPr.mergeBaseSha);
  expect(coldDone.changedFiles).toEqual(statusPr.expectedCanonicalManifest);
  await assertStoredGraphs(cold.baseUrl, coldDone, statusPr, statusSpec);

  // The restarted server owns an independent Context and cannot access the first server's graph
  // registrations. It must reconstruct both from the persistent entry without cloning or extracting again.
  await closeServer(webServer);
  webServer = undefined;
  const restarted = await startMeridian(cacheRoot);
  webServer = restarted.server;
  const warmAnalysis = await analyzePr(restarted.baseUrl, restarted.sessionId, statusPr);
  expect(warmAnalysis.map((record) => record.stage), "restart cache hit must emit only its terminal record").toEqual(["done"]);
  const warmDone = terminalAnalysis(warmAnalysis);
  expect(warmDone.cache).toBe("hit");
  expect(analysisIdentity(warmDone)).toEqual(analysisIdentity(coldDone));
  expect(warmDone.changedFiles).toEqual(statusPr.expectedCanonicalManifest);
  await assertStoredGraphs(restarted.baseUrl, warmDone, statusPr, statusSpec);

  viewUrl = `${restarted.baseUrl}/view?id=${encodeURIComponent(restarted.sessionId)}`;
  browser = await chromium.launch({ headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
}

async function teardown(): Promise<void> {
  const errors: unknown[] = [];
  for (const close of [
    () => browser?.close(),
    () => closeServer(webServer),
    () => closeServer(smartGitServer),
  ]) {
    try {
      await close();
    } catch (error) {
      errors.push(error);
    }
  }
  try {
    restoreGitRedirect?.();
    vi.unstubAllGlobals();
    if (fixture) rmSync(fixture.dir, { recursive: true, force: true });
  } catch (error) {
    errors.push(error);
  }
  browser = undefined;
  webServer = undefined;
  smartGitServer = undefined;
  restoreGitRedirect = undefined;
  fixture = undefined;
  if (errors.length > 0) throw new AggregateError(errors, "diff parity E2E cleanup failed");
}

async function assertPrDiff(context: BrowserContext, pr: DiffParityPr, spec: DiffParityCaseSpec): Promise<void> {
  const page = await context.newPage();
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await page.goto(viewUrl, { waitUntil: "networkidle" });
  await page.getByText(`${DIFF_PARITY_CASES.length} open`, { exact: true }).waitFor();
  await page.getByTitle("Open the full Pull requests page").click();
  await page.getByRole("heading", { name: "Pull requests" }).waitFor();
  const prCard = page.getByText(`#${pr.number}`, { exact: true }).locator("xpath=ancestor::button[1]");
  await prCard.waitFor();
  await prCard.click();

  const detail = page.locator("aside.mrd-scroll");
  if (spec.targetOmittedFromGitHub) {
    expect(await detail.getByTitle(pr.targetPath).count(), "target must be absent from the bounded GitHub response").toBe(0);
    const reported = pr.files.find((file) => file.reportedByGitHub !== false);
    if (!reported) throw new Error(`PR #${pr.number} needs one GitHub-reported seed file`);
    await detail.getByTitle(reported.api.filename).waitFor();
  } else {
    await detail.getByTitle(pr.targetPath).waitFor();
  }
  await detail.getByRole("button", { name: "Review in graph" }).click();
  await page.getByText("Files changed", { exact: true }).waitFor({ timeout: 120_000 });
  const provenance = new RegExp(`^${escapeRegExp(pr.headRef)} → main · head graph @[0-9a-f]{7}$`);
  await page.getByText(provenance).waitFor({ timeout: 180_000 });

  const reviewSurface = page.getByRole("region", { name: "Extracted graph" });
  await reviewSurface.waitFor();
  const targetNode = fileNodeFor(reviewSurface, pr.targetPath);
  await targetNode.waitFor({ state: "visible", timeout: 60_000 });
  await waitForGraphViewportToSettle(reviewSurface);
  if (spec.removedFile) {
    await expectDeletedRing(targetNode, `PR #${pr.number} removed file`);
  }

  for (const file of pr.files) {
    await assertTextualFileDiff(page, reviewSurface, pr, spec, file);
  }
  if (spec.deletedNode) {
    await assertDeletedNodeDiff(page, reviewSurface, pr, spec.deletedNode);
  }
  if (spec.metadataOnlyRename) {
    await assertMetadataOnlyRename(page, reviewSurface, pr, spec.metadataOnlyRename);
  }
  if (spec.addedFile) {
    await assertAddedHeadNodeAndSource(page, reviewSurface, pr, spec.addedFile);
  }
  if (spec.expectedCanonicalManifest) {
    await assertCanonicalPrFileRows(page, spec.expectedCanonicalManifest);
  }
  expect(pageErrors).toEqual([]);
  expect(unexpectedGitHubRequests).toEqual([]);
}

async function assertAddedHeadNodeAndSource(
  page: Page,
  reviewSurface: Locator,
  pr: DiffParityPr,
  added: NonNullable<DiffParityCaseSpec["addedFile"]>,
): Promise<void> {
  const file = pr.files.find((candidate) => candidate.api.filename === added.path);
  if (!file?.headCode) throw new Error(`PR #${pr.number} has no HEAD source fixture for ${added.path}`);
  const nodeId = buildNodeId({ lang: "ts", modulePath: added.path, qualname: added.qualname });
  const node = reviewSurface.locator(`.react-flow__node[data-id="${nodeId}"]`);
  await node.waitFor({ state: "visible", timeout: 60_000 });
  const baseNode = node.locator('[data-base-node="true"]');
  expect(await baseNode.getAttribute("data-base-node-kind"), `${added.path} must retain its extracted callable`).toBe("function");
  await node.getByText(added.displayName, { exact: true }).waitFor();

  await node.getByRole("button", { name: "View source" }).dispatchEvent("click");
  const modal = page.getByRole("dialog", { name: "Source code" });
  await modal.waitFor();
  await expect.poll(() => modal.getByTitle(added.path).count()).toBeGreaterThan(0);
  expect(
    await renderedSourceRows(modal),
    `PR #${pr.number} added callable must expose exact HEAD source for ${added.path}`,
  ).toEqual(file.expectedVisibleHeadRows);
  await modal.getByRole("button", { name: "Close source" }).click();
  await modal.waitFor({ state: "detached" });
}

async function assertCanonicalPrFileRows(
  page: Page,
  manifest: readonly ChangedFileManifestEntry[],
): Promise<void> {
  const expectedRows = manifest.map((file) => ({
    path: file.path,
    status: file.status,
  }));
  await expect.poll(() => reviewFileRowButtons(page).count()).toBe(manifest.length);
  await expect.poll(() => renderedReviewFileRows(page)).toEqual(expectedRows);
}

function reviewFileRowButtons(page: Page): Locator {
  const filesChanged = page.getByText("Files changed", { exact: true }).first().locator("xpath=ancestor::section[1]");
  return filesChanged.locator('button[title*=" — click to "]:has(> span:first-child[title])');
}

async function renderedReviewFileRows(page: Page): Promise<Array<{ path: string | null; status: string | null }>> {
  return reviewFileRowButtons(page).evaluateAll((buttons) => buttons.map((button) => {
    const title = button.getAttribute("title");
    const status = button.querySelector(":scope > span[title]")?.getAttribute("title");
    return { path: title?.split(" — click to ", 1)[0] ?? null, status: status ?? null };
  }));
}

async function assertTextualFileDiff(
  page: Page,
  reviewSurface: Locator,
  pr: DiffParityPr,
  spec: DiffParityCaseSpec,
  file: DiffParityFile,
): Promise<void> {
  const path = file.api.filename;
  const fileNode = fileNodeFor(reviewSurface, path);
  await fileNode.waitFor({ state: "visible", timeout: 60_000 });

  // Aim at the file frame's title strip rather than its expanded child cards. The hover card then
  // represents this exact file, matching both same-path GitHub and raw Git oracles without filtering.
  // Move away first because a newly laid-out node can otherwise appear under a stationary pointer.
  await page.mouse.move(0, 0);
  await fileNode.hover({ position: { x: 8, y: 8 } });
  const preview = page.getByRole("dialog", { name: /^Code preview for / });
  await preview.waitFor();
  await preview.getByText(path, { exact: true }).waitFor();
  await waitForDiffRows(preview, file.oracleRows.length);
  const previewRows = await renderedDiffRows(preview);
  await expectHeaderCounts(preview, file.api.additions, file.api.deletions);
  expectSameFileParity(previewRows, pr, file, "hover preview");
  if (file.headCode !== null) {
    expect(
      await renderedSourceRows(preview),
      `PR #${pr.number} ${path} hover preview must show exact same-file GitHub U3 context`,
    ).toEqual(file.expectedVisibleHeadRows);
  }

  const assertFolding = spec.assertFolding === true && path === pr.targetPath;
  if (assertFolding) {
    await assertContextFold(preview, pr);
    expectSameFileParity(await renderedDiffRows(preview), pr, file, "expanded hover preview");
  }

  // Dispatch directly so the fixed hover portal cannot intercept a coordinate click. The modal's
  // source and diff rows must be the same semantic document, not a separately reconstructed view.
  await fileNode.getByRole("button", { name: "View source" }).dispatchEvent("click");
  const modal = page.getByRole("dialog", { name: "Source code" });
  await modal.waitFor();
  await expect.poll(() => modal.getByTitle(path).count()).toBeGreaterThan(0);
  await waitForDiffRows(modal, file.oracleRows.length);
  const modalRows = await renderedDiffRows(modal);
  await expectHeaderCounts(modal, file.api.additions, file.api.deletions);
  expectSameFileParity(modalRows, pr, file, "</> modal");
  expect(modalRows, `PR #${pr.number} ${path} hover and modal diverged`).toEqual(previewRows);
  if (file.headCode !== null) {
    expect(
      await renderedSourceRows(modal),
      `PR #${pr.number} ${path} modal must show exact same-file GitHub U3 context`,
    ).toEqual(file.expectedVisibleHeadRows);
  }
  if (assertFolding) {
    await assertContextFold(modal, pr);
    expectSameFileParity(await renderedDiffRows(modal), pr, file, "expanded </> modal");
  }

  await modal.getByRole("button", { name: "Close source" }).click();
  await modal.waitFor({ state: "detached" });
}

function fileNodeFor(reviewSurface: Locator, path: string): Locator {
  const moduleId = buildNodeId({ lang: "ts", modulePath: path });
  return reviewSurface.locator(`.react-flow__node[data-id="${moduleId}"]`);
}

async function assertMetadataOnlyRename(
  page: Page,
  reviewSurface: Locator,
  pr: DiffParityPr,
  renamed: NonNullable<DiffParityCaseSpec["metadataOnlyRename"]>,
): Promise<void> {
  const moduleId = buildNodeId({ lang: "ts", modulePath: renamed.path });
  const node = reviewSurface.locator(`.react-flow__node[data-id="${moduleId}"]`);
  await node.waitFor({ state: "visible", timeout: 60_000 });
  const notice = `Renamed from ${renamed.previousPath}; Git reports no textual diff.`;

  await page.mouse.move(0, 0);
  await node.hover({ position: { x: 8, y: 8 } });
  const preview = page.getByRole("dialog", { name: /^Code preview for / });
  await preview.waitFor();
  await preview.getByText(renamed.path, { exact: true }).waitFor();
  await preview.getByText(notice, { exact: true }).waitFor();
  expect(await preview.locator("tr[data-diff-origin]").count()).toBe(0);

  await node.getByRole("button", { name: "View source" }).dispatchEvent("click");
  const modal = page.getByRole("dialog", { name: "Source code" });
  await modal.waitFor();
  await expect.poll(() => modal.getByTitle(renamed.path).count()).toBeGreaterThan(0);
  await modal.getByText(notice, { exact: true }).waitFor();
  expect(await modal.locator("tr[data-diff-origin]").count()).toBe(0);
  await modal.getByRole("button", { name: "Close source" }).click();
  await modal.waitFor({ state: "detached" });
}

async function assertDeletedNodeDiff(
  page: Page,
  reviewSurface: Locator,
  pr: DiffParityPr,
  deleted: NonNullable<DiffParityCaseSpec["deletedNode"]>,
): Promise<void> {
  const nodeId = buildNodeId({ lang: "ts", modulePath: pr.targetPath, qualname: deleted.qualname });
  const node = reviewSurface.locator(`.react-flow__node[data-id="${nodeId}"]`);
  await node.waitFor({ state: "visible", timeout: 60_000 });
  await expectDeletedRing(node, `PR #${pr.number} deleted declaration ${deleted.qualname}`);
  await assertDeletedExecutionNeighbourhood(reviewSurface, node, nodeId, deleted);

  const expectedRows = pr.oracleRows.filter((row) =>
    row.origin === "delete"
    && row.oldLine !== null
    && row.oldLine >= deleted.oldStartLine
    && row.oldLine <= deleted.oldEndLine
  );
  if (expectedRows.length === 0) {
    throw new Error(`PR #${pr.number} deleted-node oracle selected no rows for ${deleted.qualname}`);
  }
  expect(
    pr.githubPatchRows.filter((row) =>
      row.origin === "delete"
      && row.oldLine !== null
      && row.oldLine >= deleted.oldStartLine
      && row.oldLine <= deleted.oldEndLine
    ),
    `PR #${pr.number} GitHub patch and git oracle select different deleted-node rows for ${pr.targetPath}`,
  ).toEqual(expectedRows);

  await page.mouse.move(0, 0);
  await node.hover();
  const preview = page.getByRole("dialog", { name: `Code preview for ${deleted.displayName}` });
  await preview.waitFor();
  await waitForDiffRows(preview, expectedRows.length);
  const previewRows = await renderedDiffRows(preview);
  await expectHeaderCounts(preview, 0, expectedRows.length);
  expect(
    previewRows,
    `PR #${pr.number} deleted ${deleted.displayName} hover differs from same-file oracle ${pr.targetPath}`,
  ).toEqual(expectedRows);

  await node.getByRole("button", { name: "View source" }).dispatchEvent("click");
  const modal = page.getByRole("dialog", { name: "Source code" });
  await modal.waitFor();
  await waitForDiffRows(modal, expectedRows.length);
  const modalRows = await renderedDiffRows(modal);
  await expectHeaderCounts(modal, 0, expectedRows.length);
  expect(
    modalRows,
    `PR #${pr.number} deleted ${deleted.displayName} modal differs from same-file oracle ${pr.targetPath}`,
  ).toEqual(expectedRows);
  expect(modalRows, `PR #${pr.number} deleted-node hover and modal diverged`).toEqual(previewRows);
  await modal.getByRole("button", { name: "Close source" }).click();
  await modal.waitFor({ state: "detached" });
}

async function assertDeletedExecutionNeighbourhood(
  reviewSurface: Locator,
  deletedNode: Locator,
  deletedId: string,
  spec: NonNullable<DiffParityCaseSpec["deletedNode"]>,
): Promise<void> {
  const callers = spec.callers ?? [];
  const callees = spec.callees ?? [];
  if (callers.length === 0 && callees.length === 0) return;

  await nodeHeader(deletedNode).click();
  for (const caller of callers) {
    const callerId = buildNodeId({ lang: "ts", modulePath: caller.path, qualname: caller.qualname });
    await reviewSurface.locator(`.react-flow__node[data-id="${callerId}"]`).waitFor({ state: "visible" });
    await reviewSurface.locator(
      `.react-flow__edge[data-id="gdep:calls:${callerId}->${deletedId}"]`,
    ).waitFor({ state: "visible" });
  }
  for (const callee of callees) {
    const calleeId = buildNodeId({ lang: "ts", modulePath: callee.path, qualname: callee.qualname });
    await reviewSurface.locator(`.react-flow__node[data-id="${calleeId}"]`).waitFor({ state: "visible" });
    await reviewSurface.locator(
      `.react-flow__edge[data-id="gdep:calls:${deletedId}->${calleeId}"]`,
    ).waitFor({ state: "visible" });
  }
}

async function expectDeletedRing(node: Locator, label: string): Promise<void> {
  const borderColor = await node.locator('[data-base-node="true"]').first().evaluate((element) =>
    getComputedStyle(element).borderTopColor
  );
  expect(borderColor, `${label} must use the deleted-node red ring`).toBe("rgb(229, 72, 77)");
}

async function waitForDiffRows(host: Locator, count: number): Promise<void> {
  await expect.poll(() => host.locator("tr[data-diff-origin]").count(), { timeout: 30_000 }).toBe(count);
}

async function renderedDiffRows(host: Locator): Promise<ExpectedDiffRow[]> {
  const invalidContextRows = await host
    .locator("tr[data-source-line]:not([data-diff-origin])")
    .evaluateAll((rows) => rows.filter((row) =>
      row.hasAttribute("data-old-line")
      || row.hasAttribute("data-new-line")
      || row.hasAttribute("data-before-new-line")
    ).length);
  if (invalidContextRows > 0) throw new Error("context source rows must not expose diff coordinates");
  const rendered = await host.locator("tr[data-diff-origin]").evaluateAll((rows) => rows.map((row) => {
    const origin = row.getAttribute("data-diff-origin");
    const oldLine = row.getAttribute("data-old-line");
    const newLine = row.getAttribute("data-new-line");
    const beforeNewLine = row.getAttribute("data-before-new-line");
    const noNewline = row.getAttribute("data-no-newline") === "true";
    if (origin !== "add" && origin !== "delete") {
      throw new Error(`unexpected data-diff-origin '${origin ?? ""}'`);
    }
    if (origin === "add" ? oldLine !== null || newLine === null : oldLine === null || newLine !== null) {
      throw new Error(`${origin} diff row exposes the wrong old/new coordinate attributes`);
    }
    if (beforeNewLine === null || Number(beforeNewLine) < 1) {
      throw new Error(`${origin} diff row has no valid HEAD-side placement anchor`);
    }
    if (origin === "add" && Number(beforeNewLine) !== Number(newLine)) {
      throw new Error("added diff row placement anchor must equal its new-line coordinate");
    }
    const displayedText = row.lastElementChild?.textContent ?? "";
    return {
      origin,
      oldLine: oldLine === null ? null : Number(oldLine),
      newLine: newLine === null ? null : Number(newLine),
      beforeNewLine: Number(beforeNewLine),
      // CodeBlock uses one ordinary space to give an empty source row its normal line height.
      text: displayedText === " " ? "" : displayedText,
      ...(noNewline ? { noNewline: true } : {}),
    };
  }));
  const markerSides = await host.locator("tr[data-no-newline-marker]").evaluateAll((rows) =>
    rows.map((row) => row.getAttribute("data-no-newline-marker"))
  );
  const expectedMarkerSides = rendered
    .filter((row) => row.noNewline === true)
    .map((row) => row.origin === "add" ? "new" : "old");
  if (JSON.stringify(markerSides) !== JSON.stringify(expectedMarkerSides)) {
    throw new Error(`no-newline markers differ: expected ${expectedMarkerSides.join(",")}, got ${markerSides.join(",")}`);
  }
  return rendered;
}

async function renderedSourceRows(host: Locator): Promise<ExpectedSourceRow[]> {
  return host.locator("tr[data-source-line]").evaluateAll((rows) => rows.map((row) => {
    const displayedText = row.lastElementChild?.textContent ?? "";
    return {
      line: Number(row.getAttribute("data-source-line")),
      text: displayedText === " " ? "" : displayedText,
    };
  }));
}

async function assertContextFold(preview: Locator, pr: DiffParityPr): Promise<void> {
  const expectedFold = pr.expectedInternalFold;
  const headCode = pr.files[0]?.headCode;
  if (expectedFold === null || headCode === null || headCode === undefined) {
    throw new Error(`PR #${pr.number} has no internal HEAD fold fixture`);
  }
  const range = `${expectedFold.startLine}-${expectedFold.endLine}`;
  const fold = preview.locator(`tr[data-unchanged-lines="${range}"]`);
  await fold.waitFor();
  expect(await fold.getAttribute("data-unchanged-lines")).toBe(range);
  expect(await preview.locator(`tr[data-source-line="${expectedFold.startLine}"]`).count()).toBe(0);
  expect(await preview.locator(`tr[data-source-line="${expectedFold.endLine}"]`).count()).toBe(0);
  await fold.getByRole("button", { name: /^Expand \d+ unchanged lines$/ }).click();
  await preview.locator(`tr[data-source-line="${expectedFold.startLine}"]`).waitFor();
  await preview.locator(`tr[data-source-line="${expectedFold.endLine}"]`).waitFor();
  expect(await fold.getByRole("button").getAttribute("aria-expanded")).toBe("true");
  const headLines = headCode.split("\n");
  const expanded = new Map(pr.expectedVisibleHeadRows.map((row) => [row.line, row]));
  for (let line = expectedFold.startLine; line <= expectedFold.endLine; line += 1) {
    expanded.set(line, { line, text: headLines[line - 1] ?? "" });
  }
  expect(await renderedSourceRows(preview), "expanding the between-hunks fold must reveal exact HEAD text").toEqual(
    [...expanded.values()].sort((left, right) => left.line - right.line),
  );
  await fold.getByRole("button", { name: /^Collapse \d+ unchanged lines$/ }).click();
  await preview.locator(`tr[data-source-line="${expectedFold.startLine}"]`).waitFor({ state: "detached" });
  expect(await fold.getByRole("button").getAttribute("aria-expanded")).toBe("false");
}

async function waitForGraphViewportToSettle(surface: Locator): Promise<void> {
  const viewport = surface.locator(".react-flow__viewport");
  await viewport.waitFor();
  let previous = await viewport.getAttribute("style");
  let stableSamples = 0;
  // Layout-ready precedes React Flow's scheduled camera fit. Wait through that animation so the
  // node cannot move away while the hover preview's dwell timer is running on a slower runner.
  await expect.poll(async () => {
    const current = await viewport.getAttribute("style");
    stableSamples = current === previous ? stableSamples + 1 : 0;
    previous = current;
    return stableSamples;
  }, { interval: 100, timeout: 5_000 }).toBeGreaterThanOrEqual(3);
}

async function expectHeaderCounts(host: Locator, additions: number, deletions: number): Promise<void> {
  const previewLabel = host.getByLabel(`${additions} added lines, ${deletions} deleted lines`);
  if (await previewLabel.count() === 1) return;
  await host.getByText(`+${additions} lines`, { exact: true }).waitFor();
  await host.getByText(`-${deletions} lines`, { exact: true }).waitFor();
}

function expectSameFileParity(
  rows: ExpectedDiffRow[],
  pr: DiffParityPr,
  file: DiffParityFile,
  surface: string,
): void {
  const path = file.api.filename;
  expect(
    rows,
    `PR #${pr.number} ${surface} differs from GitHub U3 patch for exact path ${path}:\n${file.githubPatch}`,
  ).toEqual(file.githubPatchRows);
  expect(
    rows,
    `PR #${pr.number} ${surface} differs from raw git merge-base oracle for exact path ${path}:\n${file.oracleDiff}`,
  ).toEqual(file.oracleRows);
}

async function startMeridian(cacheRoot: string): Promise<{ server: Server; baseUrl: string; sessionId: string }> {
  const server = createWebServer({
    rendererRoot: dirname(RENDERER_INDEX),
    webUiPath: WEB_UI,
    cwd: REPO_ROOT,
    cacheRoot,
    githubClientId: "Iv1.meridian-diff-e2e",
    fallbackToken: "meridian-diff-e2e-token",
    fallbackUser: { login: "diff-e2e-reviewer", avatarUrl: null },
  });
  try {
    const baseUrl = await listenServer(server);
    const generated = await generateSession(baseUrl);
    return { server, baseUrl, sessionId: generated.id };
  } catch (error) {
    await closeServer(server);
    throw error;
  }
}

async function analyzePr(baseUrl: string, sessionId: string, pr: DiffParityPr): Promise<PrAnalysisRecord[]> {
  const response = await nativeFetch(`${baseUrl}/api/pr/analyze`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id: sessionId, prNumber: pr.number, baseRef: pr.baseRef, headRef: pr.headRef }),
  });
  if (!response.ok) {
    throw new Error(`PR #${pr.number} analysis failed (${response.status}): ${await response.text()}`);
  }
  expect(response.headers.get("content-type")).toContain("application/x-ndjson");
  const body = await response.text();
  const lines = body.split("\n").filter((line) => line.length > 0);
  if (lines.length === 0) throw new Error(`PR #${pr.number} analysis returned no NDJSON records`);
  return lines.map((line, index) => {
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch (error) {
      throw new Error(`PR #${pr.number} analysis record ${index + 1} is not JSON`, { cause: error });
    }
    return parsePrAnalysisRecord(value, index + 1);
  });
}

function parsePrAnalysisRecord(value: unknown, line: number): PrAnalysisRecord {
  const record = requireRecord(value, `analysis record ${line}`);
  const stage = record.stage;
  if (stage === "clone" || stage === "checkout" || stage === "extract") {
    requireExactKeys(record, ["stage"], `analysis ${stage} record`);
    return { stage };
  }
  if (stage === "error") {
    throw new Error(`PR analysis returned an error record: ${typeof record.message === "string" ? record.message : "invalid error"}`);
  }
  if (stage !== "done") throw new Error(`analysis record ${line} has unknown stage '${String(stage)}'`);
  requireExactKeys(record, [
    "cache",
    "changedFiles",
    "comparisonGraphId",
    "counts",
    "graphId",
    "headSha",
    "mergeBaseSha",
    "stage",
    "warnings",
  ], "analysis done record");
  const counts = requireRecord(record.counts, "analysis done counts");
  requireExactKeys(counts, ["edges", "nodes"], "analysis done counts");
  const cache = record.cache;
  if (cache !== "hit" && cache !== "miss") throw new Error("analysis done cache must be hit or miss");
  if (!Array.isArray(record.changedFiles)) throw new Error("analysis done changedFiles must be an array");
  if (!Array.isArray(record.warnings) || !record.warnings.every((warning) => typeof warning === "string")) {
    throw new Error("analysis done warnings must be strings");
  }
  return {
    stage,
    graphId: requireNonEmptyString(record.graphId, "analysis done graphId"),
    comparisonGraphId: requireNonEmptyString(record.comparisonGraphId, "analysis done comparisonGraphId"),
    headSha: requireSha(record.headSha, "analysis done headSha"),
    mergeBaseSha: requireSha(record.mergeBaseSha, "analysis done mergeBaseSha"),
    counts: {
      nodes: requireCount(counts.nodes, "analysis done node count"),
      edges: requireCount(counts.edges, "analysis done edge count"),
    },
    changedFiles: record.changedFiles.map((file, index) => parseChangedFile(file, index)),
    warnings: record.warnings,
    cache,
  };
}

function parseChangedFile(value: unknown, index: number): ChangedFileManifestEntry {
  const file = requireRecord(value, `changedFiles[${index}]`);
  const path = requireNonEmptyString(file.path, `changedFiles[${index}].path`);
  const status = file.status;
  if (status === "renamed") {
    requireExactKeys(file, ["path", "previousPath", "status"], `changedFiles[${index}]`);
    const previousPath = requireNonEmptyString(file.previousPath, `changedFiles[${index}].previousPath`);
    if (previousPath === path) throw new Error(`changedFiles[${index}] rename must change its path`);
    return { path, status, previousPath };
  }
  if (status !== "added" && status !== "modified" && status !== "deleted") {
    throw new Error(`changedFiles[${index}] has invalid status '${String(status)}'`);
  }
  requireExactKeys(file, ["path", "status"], `changedFiles[${index}]`);
  return { path, status };
}

function terminalAnalysis(records: readonly PrAnalysisRecord[]): PrAnalysisDone {
  const terminal = records.filter((record): record is PrAnalysisDone => record.stage === "done");
  if (terminal.length !== 1 || records.at(-1) !== terminal[0]) {
    throw new Error("PR analysis must end with exactly one done record");
  }
  return terminal[0];
}

function analysisIdentity(done: PrAnalysisDone): Omit<PrAnalysisDone, "stage" | "cache"> {
  return {
    graphId: done.graphId,
    comparisonGraphId: done.comparisonGraphId,
    headSha: done.headSha,
    mergeBaseSha: done.mergeBaseSha,
    counts: done.counts,
    changedFiles: done.changedFiles,
    warnings: done.warnings,
  };
}

async function assertStoredGraphs(
  baseUrl: string,
  done: PrAnalysisDone,
  pr: DiffParityPr,
  spec: DiffParityCaseSpec & {
    addedFile: NonNullable<DiffParityCaseSpec["addedFile"]>;
    deletedNode: NonNullable<DiffParityCaseSpec["deletedNode"]>;
  },
): Promise<void> {
  const head = await fetchGraph(baseUrl, done.graphId);
  const comparison = await fetchGraph(baseUrl, done.comparisonGraphId);
  expect(head.target.vcs?.commit, "HEAD graph endpoint must serve the analyzed commit").toBe(done.headSha);
  expect(comparison.target.vcs?.commit, "comparison graph endpoint must serve the merge-base commit").toBe(done.mergeBaseSha);
  expect(
    { nodes: head.nodes.length, edges: head.edges.length },
    "HEAD graph registration must match the terminal counts",
  ).toEqual(done.counts);
  expect(comparison.nodes.length, "comparison graph endpoint must retain its extracted base nodes").toBeGreaterThan(0);
  expect(
    changedFileManifestFromExtensions(head.extensions),
    "HEAD graph endpoint must retain the exact local-Git transaction manifest",
  ).toEqual(pr.expectedCanonicalManifest);

  const addedId = buildNodeId({ lang: "ts", modulePath: spec.addedFile.path, qualname: spec.addedFile.qualname });
  const deletedId = buildNodeId({ lang: "ts", modulePath: pr.targetPath, qualname: spec.deletedNode.qualname });
  const headIds = new Set(head.nodes.map((node) => node.id));
  const comparisonIds = new Set(comparison.nodes.map((node) => node.id));
  expect(headIds.has(addedId), "HEAD graph endpoint must contain the added callable").toBe(true);
  expect(headIds.has(deletedId), "HEAD graph endpoint must not retain the deleted callable").toBe(false);
  expect(comparisonIds.has(deletedId), "merge-base graph endpoint must contain the later-deleted callable").toBe(true);
  expect(comparisonIds.has(addedId), "merge-base graph endpoint must not contain the later-added callable").toBe(false);
}

async function fetchGraph(baseUrl: string, graphId: string): Promise<GraphArtifact> {
  const response = await nativeFetch(`${baseUrl}/api/graph?id=${encodeURIComponent(graphId)}`);
  if (!response.ok) throw new Error(`stored graph ${graphId} failed (${response.status}): ${await response.text()}`);
  const value: unknown = await response.json();
  const graph = requireRecord(value, `stored graph ${graphId}`);
  const target = requireRecord(graph.target, `stored graph ${graphId} target`);
  if (!Array.isArray(graph.nodes) || !Array.isArray(graph.edges)) {
    throw new Error(`stored graph ${graphId} must contain node and edge arrays`);
  }
  if (target.vcs !== undefined) requireRecord(target.vcs, `stored graph ${graphId} target.vcs`);
  return value as GraphArtifact;
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function requireExactKeys(record: Record<string, unknown>, keys: readonly string[], label: string): void {
  const actual = Object.keys(record).sort();
  const expected = [...keys].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${label} keys must be ${expected.join(", ")}; received ${actual.join(", ")}`);
  }
}

function requireNonEmptyString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) throw new Error(`${label} must be a non-empty string`);
  return value;
}

function requireSha(value: unknown, label: string): string {
  const sha = requireNonEmptyString(value, label);
  if (!/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/i.test(sha)) throw new Error(`${label} must be a 40- or 64-character Git SHA`);
  return sha;
}

function requireCount(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative safe integer`);
  }
  return value;
}

async function generateSession(baseUrl: string): Promise<{ id: string }> {
  const response = await nativeFetch(`${baseUrl}/api/generate`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ kind: "github", value: "e2e/shop", subdir: "", ref: "" }),
  });
  if (!response.ok) {
    throw new Error(`diff parity session generation failed (${response.status}): ${await response.text()}`);
  }
  return (await response.json()) as { id: string };
}

function fakeGitHub(source: DiffParityFixture): typeof fetch {
  const summaries = source.prs.map((pr) => ({
    number: pr.number,
    title: pr.title,
    body: null,
    user: { login: "diff-e2e-reviewer" },
    head: { ref: pr.headRef, sha: pr.headSha },
    base: { ref: pr.baseRef, sha: pr.baseSha },
    updated_at: `2026-07-${String(pr.number - 20).padStart(2, "0")}T10:00:00Z`,
    draft: false,
    state: "open",
    html_url: `https://github.com/e2e/shop/pull/${pr.number}`,
  }));
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    if (url.hostname !== "api.github.com") return nativeFetch(input, init);
    const path = url.pathname;
    if (request.method === "GET" && path === "/repos/e2e/shop/pulls") return json(summaries);
    const one = /^\/repos\/e2e\/shop\/pulls\/(\d+)$/.exec(path);
    if (request.method === "GET" && one) {
      const summary = summaries.find((candidate) => candidate.number === Number(one[1]));
      return summary ? json(summary) : json({ message: "not found" }, 404);
    }
    const files = /^\/repos\/e2e\/shop\/pulls\/(\d+)\/files$/.exec(path);
    if (request.method === "GET" && files) {
      const pr = source.prs.find((candidate) => candidate.number === Number(files[1]));
      return pr
        ? json(pr.files.filter((file) => file.reportedByGitHub !== false).map((file) => file.api))
        : json({ message: "not found" }, 404);
    }
    if (request.method === "GET" && /^\/repos\/e2e\/shop\/pulls\/\d+\/(comments|reviews)$/.test(path)) {
      return json([]);
    }
    if (request.method === "GET" && /^\/repos\/e2e\/shop\/commits\/[0-9a-f]+\/check-runs$/.test(path)) {
      return json({ total_count: 0, check_runs: [] });
    }
    const contents = "/repos/e2e/shop/contents/";
    if (request.method === "GET" && path.startsWith(contents)) {
      const ref = url.searchParams.get("ref");
      const pr = source.prs.find((candidate) => candidate.headRef === ref || candidate.headSha === ref);
      const filePath = decodeURIComponent(path.slice(contents.length));
      const file = pr?.files.find((candidate) => candidate.api.filename === filePath);
      return file && file.headCode !== null
        ? json({ encoding: "base64", content: Buffer.from(file.headCode).toString("base64") })
        : json({}, 404);
    }
    unexpectedGitHubRequests.push(`${request.method} ${url.pathname}${url.search}`);
    return json({ message: "unexpected GitHub fixture request" }, 404);
  }) as typeof fetch;
}

// git-exec inherits these variables, redirecting both the initial shallow clone and all PR-head
// analysis fetches without changing production argv or reaching github.com.
function installGitRedirect(repoUrl: string): () => void {
  const oldCount = process.env.GIT_CONFIG_COUNT;
  const oldKey = process.env.GIT_CONFIG_KEY_0;
  const oldValue = process.env.GIT_CONFIG_VALUE_0;
  process.env.GIT_CONFIG_COUNT = "1";
  process.env.GIT_CONFIG_KEY_0 = `url.${repoUrl}.insteadOf`;
  process.env.GIT_CONFIG_VALUE_0 = "https://github.com/e2e/shop.git";
  return () => {
    restoreEnv("GIT_CONFIG_COUNT", oldCount);
    restoreEnv("GIT_CONFIG_KEY_0", oldKey);
    restoreEnv("GIT_CONFIG_VALUE_0", oldValue);
  };
}

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

async function closeServer(server: Server | undefined): Promise<void> {
  if (!server?.listening) return;
  await new Promise<void>((resolveClose, reject) => {
    server.close((error) => (error ? reject(error) : resolveClose()));
  });
}
