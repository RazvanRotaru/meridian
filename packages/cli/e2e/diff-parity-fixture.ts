/**
 * A self-contained GitHub-PR catalog for code-diff browser parity. Every advertised PR is a real
 * ref in a local bare repository; API patches and the independent UI oracle both come from git,
 * while the smart-HTTP harness makes the production clone/analyze path stay entirely offline.
 */

import { execFileSync } from "node:child_process";
import {
  appendFileSync,
  cpSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChangedFileManifestEntry } from "@meridian/core";
import { FIXTURE } from "./harness";

export interface DiffParityCaseSpec {
  number: number;
  label: string;
  title: string;
  headRef: string;
  targetPath: string;
  /** This case also owns the context-folding browser assertion. */
  assertFolding?: boolean;
  /** A declaration removed from an otherwise surviving file, asserted independently of the file. */
  deletedNode?: {
    qualname: string;
    displayName: string;
    oldStartLine: number;
    oldEndLine: number;
  };
  /** The target path is absent from HEAD and must be rendered entirely from merge-base source. */
  removedFile?: boolean;
  /** GitHub's bounded files response omits the target; the local manifest must recover it. */
  targetOmittedFromGitHub?: boolean;
  /** A pure rename in the same PR must be explicit even though it has no +/- rows. */
  metadataOnlyRename?: { path: string; previousPath: string };
  /** A source-backed added file whose callable is asserted through the prepared HEAD graph. */
  addedFile?: { path: string; qualname: string; displayName: string };
  /** The exact local-Git manifest expected from the prepared artifact, in terminal response order. */
  expectedCanonicalManifest?: readonly ChangedFileManifestEntry[];
}

export const STATUS_TRANSACTION_MANIFEST = [
  { path: "src/legacyDiscountService.ts", status: "deleted" },
  { path: "src/renamedOnly.ts", status: "renamed", previousPath: "src/renameOnly.ts" },
  { path: "src/services/orderService.ts", status: "modified" },
  { path: "src/statusAdded.ts", status: "added" },
] as const satisfies readonly ChangedFileManifestEntry[];

export const DIFF_PARITY_CASES: readonly DiffParityCaseSpec[] = [
  {
    number: 31,
    label: "mixed replacement, pure deletion, and multiple hunks",
    title: "Reshape the order workflow",
    headRef: "diff/mixed-edits",
    targetPath: "src/services/orderService.ts",
    assertFolding: true,
    deletedNode: {
      qualname: "OrderService.getOrder",
      displayName: "getOrder",
      oldStartLine: 28,
      oldEndLine: 30,
    },
  },
  {
    number: 32,
    label: "earlier insertion shifts a later replacement",
    title: "Centralize known discount codes",
    headRef: "diff/shifted-lines",
    targetPath: "src/pricing/pricingService.ts",
  },
  {
    number: 33,
    label: "diverged main uses the merge base",
    title: "Change the order timestamp on a diverged branch",
    headRef: "diff/diverged-base",
    targetPath: "src/services/orderService.ts",
  },
  {
    number: 34,
    label: "fully removed source file stays inspectable",
    title: "Remove the retired discount service",
    headRef: "diff/removed-file",
    targetPath: "src/legacyDiscountService.ts",
    removedFile: true,
    targetOmittedFromGitHub: true,
    metadataOnlyRename: { path: "src/renamedOnly.ts", previousPath: "src/renameOnly.ts" },
    addedFile: { path: "src/statusAdded.ts", qualname: "statusAdded", displayName: "statusAdded" },
    expectedCanonicalManifest: STATUS_TRANSACTION_MANIFEST,
    deletedNode: {
      qualname: "LegacyDiscountService.apply",
      displayName: "apply",
      oldStartLine: 3,
      oldEndLine: 6,
    },
  },
] as const;

export interface ExpectedDiffRow {
  origin: "add" | "delete";
  oldLine: number | null;
  newLine: number | null;
  /** Exact HEAD-side gap where this row belongs; additions use their own new line. */
  beforeNewLine: number;
  text: string;
  noNewline?: boolean;
}

export interface ExpectedSourceRow {
  line: number;
  text: string;
}

export interface DiffParityFile {
  api: {
    filename: string;
    status: "added" | "modified" | "removed";
    additions: number;
    deletions: number;
    patch?: string;
  };
  /** False simulates a changed file beyond GitHub's bounded pull-files response. */
  reportedByGitHub?: boolean;
  /** Null for a removed path: the GitHub HEAD contents endpoint correctly returns 404. */
  headCode: string | null;
  /** Changed rows parsed from this exact file's GitHub-style U3 patch. */
  githubPatchRows: ExpectedDiffRow[];
  /** Changed rows parsed independently from raw `git diff -U0` for this exact file. */
  oracleRows: ExpectedDiffRow[];
  /** Exact HEAD rows visible under the file's GitHub U3 context windows. */
  expectedVisibleHeadRows: ExpectedSourceRow[];
  githubPatch: string;
  oracleDiff: string;
}

export interface DiffParityPr {
  number: number;
  label: string;
  title: string;
  headRef: string;
  headSha: string;
  baseRef: "main";
  baseSha: string;
  mergeBaseSha: string;
  targetPath: string;
  additions: number;
  deletions: number;
  /** Changed rows parsed from the exact target file's GitHub-style U3 patch. */
  githubPatchRows: ExpectedDiffRow[];
  oracleRows: ExpectedDiffRow[];
  /** Exact HEAD source rows visible under GitHub's three-line context rule. */
  expectedVisibleHeadRows: ExpectedSourceRow[];
  /** Untouched HEAD range strictly between two U3 hunk windows, used by the expansion scenario. */
  expectedInternalFold: { startLine: number; endLine: number } | null;
  /** GitHub-style U3 patch for targetPath, retained in failures to prove same-file parity. */
  githubPatch: string;
  oracleDiff: string;
  files: DiffParityFile[];
  expectedCanonicalManifest: readonly ChangedFileManifestEntry[] | null;
}

export interface DiffParityFixture {
  dir: string;
  bareRepo: string;
  worktree: string;
  mainSha: string;
  prs: DiffParityPr[];
}

export function buildDiffParityFixture(): DiffParityFixture {
  const dir = mkdtempSync(join(tmpdir(), "meridian-diff-parity-"));
  try {
    return populateFixture(dir);
  } catch (error) {
    rmSync(dir, { recursive: true, force: true });
    throw error;
  }
}

function populateFixture(dir: string): DiffParityFixture {
  const bareRepo = join(dir, "repo.git");
  const worktree = join(dir, "worktree");
  git(["init", "--bare", bareRepo]);
  git(["clone", bareRepo, worktree]);
  git(["config", "user.name", "Meridian Diff E2E"], worktree);
  git(["config", "user.email", "diff-e2e@meridian.test"], worktree);
  git(["config", "commit.gpgsign", "false"], worktree);
  copyOrdersFixture(worktree);
  // A removed file with no terminal newline exercises Git's old-side marker all the way through
  // the canonical parser and both shared code-diff hosts.
  writeFileSync(join(worktree, "src/legacyDiscountService.ts"), LEGACY_DISCOUNT_SERVICE.trimEnd());
  writeFileSync(join(worktree, "src/renameOnly.ts"), RENAME_ONLY_SOURCE);
  // Keep PR #32's entire textual change beyond both the historical 2,000-line and 2MB source caps.
  // Its browser assertion therefore proves that exact diff zones are not silently lost in a large
  // but otherwise ordinary source file.
  const pricingPath = join(worktree, "src/pricing/pricingService.ts");
  writeFileSync(pricingPath, `${LARGE_SOURCE_PREFIX}${readFileSync(pricingPath, "utf8")}`);
  git(["switch", "-c", "main"], worktree);
  commitAll(worktree, "seed orders service", 1);
  git(["push", "-u", "origin", "main"], worktree);
  git(["symbolic-ref", "HEAD", "refs/heads/main"], bareRepo);
  const forkSha = git(["rev-parse", "HEAD"], worktree).trim();

  // Advance main in the same file the diverged PR will touch. A two-dot main..head comparison will
  // falsely report this function as deleted; GitHub's merge-base comparison must not include it.
  appendFileSync(join(worktree, "src/services/orderService.ts"), MAIN_ONLY_CHANGE);
  commitAll(worktree, "advance main independently", 2);
  git(["push", "origin", "main"], worktree);
  const mainSha = git(["rev-parse", "main"], worktree).trim();

  createMixedPr(worktree, mainSha);
  createShiftedPr(worktree, mainSha);
  createDivergedPr(worktree, forkSha);
  createRemovedFilePr(worktree, mainSha);

  const prs = DIFF_PARITY_CASES.map((spec) => materializePr(worktree, mainSha, spec));
  assertDivergenceCase(worktree, mainSha, prs.find((pr) => pr.number === 33)!);
  return { dir, bareRepo, worktree, mainSha, prs };
}

function createMixedPr(worktree: string, start: string): void {
  const spec = caseSpec(31);
  git(["switch", "-C", spec.headRef, start], worktree);
  const path = join(worktree, spec.targetPath);
  let source = readFileSync(path, "utf8");
  source = replaceExactly(
    source,
    `    const money = this.pricing.price(request);\n    const order = this.assemble(request, money);`,
    `    const priced = this.pricing.price(request);\n    const money = { ...priced, totalCents: priced.totalCents };\n    const order = this.assemble(request, money);`,
  );
  source = replaceExactly(
    source,
    `  /** Look up an order that was placed earlier. */\n  getOrder(id: string): Order | undefined {\n    return this.repository.findById(id);\n  }\n\n`,
    "",
  );
  source = replaceExactly(
    source,
    `    return "2026-01-01T00:00:00.000Z";`,
    `    return new Date(0).toISOString();`,
  );
  // Also remove the terminal newline. Git's marker is part of the semantic diff and must survive
  // the local parser, shared renderer, and independent browser oracle.
  writeFileSync(path, source.trimEnd());
  commitAndPublish(worktree, spec, "mix replacements and deletions", 3);
}

function createShiftedPr(worktree: string, start: string): void {
  const spec = caseSpec(32);
  git(["switch", "-C", spec.headRef, start], worktree);
  const path = join(worktree, spec.targetPath);
  let source = readFileSync(path, "utf8");
  source = replaceExactly(
    source,
    `const TAX_RATE = 0.2;`,
    `const TAX_RATE = 0.2;\n\nconst KNOWN_DISCOUNT_CODES = new Set([\n  "WELCOME10",\n  "LOYAL10",\n  "SUMMER10",\n]);`,
  );
  source = replaceExactly(
    source,
    `    return code === "WELCOME10" || code === "LOYAL10";`,
    `    return KNOWN_DISCOUNT_CODES.has(code);`,
  );
  writeFileSync(path, source);
  commitAndPublish(worktree, spec, "shift source before a later edit", 4);
}

function createDivergedPr(worktree: string, forkSha: string): void {
  const spec = caseSpec(33);
  git(["switch", "-C", spec.headRef, forkSha], worktree);
  const path = join(worktree, spec.targetPath);
  const source = replaceExactly(
    readFileSync(path, "utf8"),
    `    return "2026-01-01T00:00:00.000Z";`,
    `    return "2030-01-01T00:00:00.000Z";`,
  );
  writeFileSync(path, source);
  commitAndPublish(worktree, spec, "change timestamp from the original fork", 5);
}

function createRemovedFilePr(worktree: string, start: string): void {
  const spec = caseSpec(34);
  git(["switch", "-C", spec.headRef, start], worktree);
  git(["rm", spec.targetPath], worktree);
  if (spec.metadataOnlyRename) {
    git(["mv", spec.metadataOnlyRename.previousPath, spec.metadataOnlyRename.path], worktree);
  }
  if (spec.addedFile) {
    writeFileSync(join(worktree, spec.addedFile.path), STATUS_ADDED_SOURCE);
  }
  const anchorPath = join(worktree, "src/services/orderService.ts");
  writeFileSync(anchorPath, replaceExactly(
    readFileSync(anchorPath, "utf8"),
    `  return "main-only";`,
    `  return "retained-after-cleanup";`,
  ));
  commitAndPublish(worktree, spec, "remove retired discount service", 6);
}

function materializePr(worktree: string, mainSha: string, spec: DiffParityCaseSpec): DiffParityPr {
  const headSha = git(["rev-parse", spec.headRef], worktree).trim();
  const mergeBaseSha = git(["merge-base", mainSha, headSha], worktree).trim();
  const oracleDiff = canonicalDiff(worktree, mergeBaseSha, headSha, spec.targetPath, 0);
  const parsed = parseOracleDiff(oracleDiff);
  if (parsed.rows.length === 0) {
    throw new Error(`diff parity fixture PR #${spec.number} produced no oracle rows`);
  }
  if (spec.number === 31) {
    if (parsed.hunks.length < 2 || !parsed.hunks.some((hunk) => hunk.length > 0 && hunk.every((row) => row.origin === "delete"))) {
      throw new Error("mixed diff fixture must contain multiple hunks and a delete-only hunk");
    }
  }
  if (spec.number === 32 && parsed.rows.some((row) => (row.newLine ?? row.oldLine ?? 0) <= 2_000)) {
    throw new Error("large shifted-lines fixture must keep every diff row beyond line 2,000");
  }
  const additions = parsed.rows.filter((row) => row.origin === "add").length;
  const deletions = parsed.rows.length - additions;
  if (spec.removedFile && (additions !== 0 || deletions === 0)) {
    throw new Error(`removed-file fixture PR #${spec.number} must contain only deleted rows`);
  }
  assertNumstat(worktree, mergeBaseSha, headSha, spec.targetPath, additions, deletions);
  const patchDiff = canonicalDiff(worktree, mergeBaseSha, headSha, spec.targetPath, 3);
  const patchStart = patchDiff.indexOf("@@");
  if (patchStart === -1) throw new Error(`diff parity fixture PR #${spec.number} has no U3 patch`);
  const githubPatch = patchDiff.slice(patchStart).trimEnd();
  const githubPatchRows = parseOracleDiff(githubPatch).rows;
  if (JSON.stringify(githubPatchRows) !== JSON.stringify(parsed.rows)) {
    throw new Error(
      `GitHub U3 patch rows differ from raw git -U0 rows for PR #${spec.number} exact path ${spec.targetPath}`,
    );
  }
  const headCode = spec.removedFile ? null : git(["show", `${headSha}:${spec.targetPath}`], worktree);
  if (spec.number === 32 && Buffer.byteLength(headCode ?? "", "utf8") <= 2_000_000) {
    throw new Error("large shifted-lines fixture must place its diff beyond the former 2MB source cap");
  }
  const headLines = headCode?.split("\n") ?? [];
  const visibleHeadLines = headCode === null
    ? []
    : visibleHeadLinesFromPatch(githubPatch, headLines.length);
  const expectedInternalFold = internalFoldBetweenHunks(visibleHeadLines);
  if (spec.assertFolding && expectedInternalFold === null) {
    throw new Error(`diff parity fixture PR #${spec.number} produced no untouched range between hunks`);
  }
  const targetFile: DiffParityFile = {
    api: {
      filename: spec.targetPath,
      status: spec.removedFile ? "removed" : "modified",
      additions,
      deletions,
      // PR #33 intentionally receives no API patch. Its diverged-base assertion can pass only if
      // the prepared UI consumes the canonical local merge-base diff rather than GitHub detail.
      ...(spec.number === 33 ? {} : { patch: githubPatch }),
    },
    headCode,
    reportedByGitHub: spec.targetOmittedFromGitHub !== true,
    githubPatchRows,
    oracleRows: parsed.rows,
    expectedVisibleHeadRows: sourceRows(headLines, visibleHeadLines),
    githubPatch,
    oracleDiff,
  };
  const files = [targetFile];
  if (spec.targetOmittedFromGitHub) {
    files.push(materializeSupportingFile(worktree, mergeBaseSha, headSha, "src/services/orderService.ts", "modified"));
  }
  if (spec.addedFile) {
    files.push(materializeSupportingFile(worktree, mergeBaseSha, headSha, spec.addedFile.path, "added"));
  }
  if (spec.expectedCanonicalManifest) {
    assertExactStatusTransaction(worktree, mergeBaseSha, headSha, spec.expectedCanonicalManifest);
  }
  return {
    number: spec.number,
    label: spec.label,
    title: spec.title,
    headRef: spec.headRef,
    headSha,
    baseRef: "main",
    baseSha: mainSha,
    mergeBaseSha,
    targetPath: spec.targetPath,
    additions,
    deletions,
    githubPatchRows,
    oracleRows: parsed.rows,
    expectedVisibleHeadRows: sourceRows(headLines, visibleHeadLines),
    expectedInternalFold,
    githubPatch,
    oracleDiff,
    files,
    expectedCanonicalManifest: spec.expectedCanonicalManifest ?? null,
  };
}

function materializeSupportingFile(
  worktree: string,
  mergeBaseSha: string,
  headSha: string,
  path: string,
  status: "added" | "modified",
): DiffParityFile {
  const patchDiff = canonicalDiff(worktree, mergeBaseSha, headSha, path, 3);
  const patchStart = patchDiff.indexOf("@@");
  if (patchStart === -1) throw new Error(`supporting diff fixture ${path} has no U3 patch`);
  const githubPatch = patchDiff.slice(patchStart).trimEnd();
  const githubPatchRows = parseOracleDiff(githubPatch).rows;
  const oracleDiff = canonicalDiff(worktree, mergeBaseSha, headSha, path, 0);
  const parsed = parseOracleDiff(oracleDiff);
  if (JSON.stringify(githubPatchRows) !== JSON.stringify(parsed.rows)) {
    throw new Error(`GitHub U3 patch rows differ from raw git -U0 rows for supporting path ${path}`);
  }
  const additions = parsed.rows.filter((row) => row.origin === "add").length;
  const deletions = parsed.rows.length - additions;
  assertNumstat(worktree, mergeBaseSha, headSha, path, additions, deletions);
  const headCode = git(["show", `${headSha}:${path}`], worktree);
  const headLines = headCode.split("\n");
  return {
    api: {
      filename: path,
      status,
      additions,
      deletions,
      patch: githubPatch,
    },
    headCode,
    githubPatchRows,
    oracleRows: parsed.rows,
    expectedVisibleHeadRows: sourceRows(headLines, visibleHeadLinesFromPatch(githubPatch, headLines.length)),
    githubPatch,
    oracleDiff,
  };
}

/**
 * Keep this fixture independent of Meridian's manifest parser: raw Git itself must report one and
 * only one A/M/D/R100 transaction before its values can become the server/browser oracle.
 */
function assertExactStatusTransaction(
  worktree: string,
  mergeBaseSha: string,
  headSha: string,
  expectedManifest: readonly ChangedFileManifestEntry[],
): void {
  const actual = git([
    "diff",
    "--no-ext-diff",
    "--no-color",
    "--name-status",
    "--find-renames=100%",
    mergeBaseSha,
    headSha,
  ], worktree)
    .trim()
    .split("\n")
    .filter(Boolean)
    .sort();
  const expected = expectedManifest.map((entry) => {
    if (entry.status === "renamed") return `R100\t${entry.previousPath}\t${entry.path}`;
    const status = entry.status === "added" ? "A" : entry.status === "modified" ? "M" : "D";
    return `${status}\t${entry.path}`;
  }).sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`status transaction differs from A/M/D/R100 oracle:\n${actual.join("\n")}`);
  }
}

function sourceRows(lines: readonly string[], lineNumbers: readonly number[]): ExpectedSourceRow[] {
  return lineNumbers.map((line) => ({ line, text: lines[line - 1] ?? "" }));
}

/** The fold under test must be strictly between hunk windows, never a leading/trailing fold. */
function internalFoldBetweenHunks(visibleLines: readonly number[]): { startLine: number; endLine: number } | null {
  for (let index = 1; index < visibleLines.length; index += 1) {
    const startLine = visibleLines[index - 1] + 1;
    const endLine = visibleLines[index] - 1;
    if (startLine <= endLine) return { startLine, endLine };
  }
  return null;
}

/**
 * Intentionally independent of the production GitHub/local-diff parsers. The oracle reads raw U0
 * hunk rows and tracks each side's cursor directly, preserving patch order and exact source text.
 */
export function parseOracleDiff(diff: string): {
  rows: ExpectedDiffRow[];
  hunks: ExpectedDiffRow[][];
} {
  const rows: ExpectedDiffRow[] = [];
  const hunks: ExpectedDiffRow[][] = [];
  let active: ExpectedDiffRow[] | null = null;
  let lastChangedRow: ExpectedDiffRow | null = null;
  let markerCanAttach = false;
  let oldLine = 0;
  let newLine = 0;
  for (const raw of diff.split("\n")) {
    const header = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(raw);
    if (header) {
      const oldCount = header[2] === undefined ? 1 : Number(header[2]);
      const newCount = header[4] === undefined ? 1 : Number(header[4]);
      // Unified ranges with zero rows name the line immediately before the empty range. Convert
      // those header coordinates to the next-row cursor used by the rendered placement contract.
      oldLine = Number(header[1]) + (oldCount === 0 ? 1 : 0);
      newLine = Number(header[3]) + (newCount === 0 ? 1 : 0);
      active = [];
      hunks.push(active);
      lastChangedRow = null;
      markerCanAttach = false;
      continue;
    }
    if (active === null) continue;
    if (raw.startsWith("\\")) {
      if (raw === "\\ No newline at end of file" && markerCanAttach && lastChangedRow !== null) {
        lastChangedRow.noNewline = true;
      }
      markerCanAttach = false;
      continue;
    }
    if (raw.startsWith("-")) {
      const row: ExpectedDiffRow = {
        origin: "delete",
        oldLine,
        newLine: null,
        beforeNewLine: newLine,
        text: raw.slice(1),
      };
      rows.push(row);
      active.push(row);
      lastChangedRow = row;
      markerCanAttach = true;
      oldLine += 1;
    } else if (raw.startsWith("+")) {
      const row: ExpectedDiffRow = {
        origin: "add",
        oldLine: null,
        newLine,
        beforeNewLine: newLine,
        text: raw.slice(1),
      };
      rows.push(row);
      active.push(row);
      lastChangedRow = row;
      markerCanAttach = true;
      newLine += 1;
    } else if (raw.startsWith(" ")) {
      lastChangedRow = null;
      markerCanAttach = false;
      oldLine += 1;
      newLine += 1;
    }
  }
  return { rows, hunks };
}

/** GitHub's own U3 hunk headers are the independent visible-source oracle. */
function visibleHeadLinesFromPatch(patch: string, lineCount: number): number[] {
  const visible = new Set<number>();
  for (const raw of patch.split("\n")) {
    const header = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(raw);
    if (!header) continue;
    const start = Number(header[1]);
    const count = header[2] === undefined ? 1 : Number(header[2]);
    for (let line = Math.max(1, start); line <= Math.min(lineCount, start + count - 1); line += 1) {
      visible.add(line);
    }
  }
  return [...visible].sort((left, right) => left - right);
}

function assertDivergenceCase(worktree: string, mainSha: string, pr: DiffParityPr): void {
  if (pr.mergeBaseSha === mainSha) {
    throw new Error("diverged diff fixture unexpectedly shares main's tip as its merge base");
  }
  const twoDot = git([
    "diff",
    "--no-ext-diff",
    "--no-color",
    "--unified=0",
    `${mainSha}..${pr.headSha}`,
    "--",
    pr.targetPath,
  ], worktree);
  if (!twoDot.includes("mainOnlyAuditMarker") || pr.oracleDiff.includes("mainOnlyAuditMarker")) {
    throw new Error("diverged fixture does not distinguish two-dot from merge-base semantics");
  }
}

function canonicalDiff(
  worktree: string,
  baseSha: string,
  headSha: string,
  path: string,
  context: number,
): string {
  return git([
    "diff",
    "--no-ext-diff",
    "--no-color",
    "--find-renames",
    `--unified=${context}`,
    baseSha,
    headSha,
    "--",
    path,
  ], worktree);
}

function assertNumstat(
  worktree: string,
  baseSha: string,
  headSha: string,
  path: string,
  additions: number,
  deletions: number,
): void {
  const [gitAdditions, gitDeletions] = git(["diff", "--numstat", baseSha, headSha, "--", path], worktree)
    .trim()
    .split("\t", 2)
    .map(Number);
  if (gitAdditions !== additions || gitDeletions !== deletions) {
    throw new Error(`oracle row count differs from git numstat for ${path}`);
  }
}

function commitAndPublish(
  worktree: string,
  spec: DiffParityCaseSpec,
  message: string,
  ordinal: number,
): void {
  commitAll(worktree, message, ordinal);
  git([
    "push",
    "origin",
    `${spec.headRef}:refs/heads/${spec.headRef}`,
    `${spec.headRef}:refs/pull/${spec.number}/head`,
  ], worktree);
}

function commitAll(worktree: string, message: string, ordinal: number): void {
  git(["add", "."], worktree);
  execFileSync("git", ["commit", "-m", message], {
    cwd: worktree,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      GIT_AUTHOR_DATE: `2026-07-${String(ordinal).padStart(2, "0")}T10:00:00Z`,
      GIT_COMMITTER_DATE: `2026-07-${String(ordinal).padStart(2, "0")}T10:00:00Z`,
    },
  });
}

function copyOrdersFixture(worktree: string): void {
  for (const entry of readdirSync(FIXTURE)) {
    cpSync(join(FIXTURE, entry), join(worktree, entry), { recursive: true });
  }
}

function caseSpec(number: number): DiffParityCaseSpec {
  const spec = DIFF_PARITY_CASES.find((candidate) => candidate.number === number);
  if (!spec) throw new Error(`missing diff parity case #${number}`);
  return spec;
}

function replaceExactly(source: string, before: string, after: string): string {
  if (!source.includes(before)) throw new Error(`fixture source did not contain expected text: ${before}`);
  return source.replace(before, after);
}

function git(args: string[], cwd?: string): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    // The large-file parity case deliberately exceeds Node's 1 MiB execSync default.
    maxBuffer: 64 * 1024 * 1024,
  });
}

const MAIN_ONLY_CHANGE = `

export function mainOnlyAuditMarker(): string {
  return "main-only";
}
`;

const LARGE_SOURCE_PREFIX = [
  `// unchanged byte-budget sentinel ${"x".repeat(2_010_000)}`,
  ...Array.from(
    { length: 2_050 },
    (_value, index) => `// unchanged large-file context ${index + 1}`,
  ),
].join("\n") + "\n";

const LEGACY_DISCOUNT_SERVICE = `/** Retired percentage discount kept only for migration compatibility. */
export class LegacyDiscountService {
  apply(totalCents: number, percent: number): number {
    const discount = Math.round(totalCents * (percent / 100));
    return totalCents - discount;
  }
}
`;

const RENAME_ONLY_SOURCE = `/** Stable source used to verify a pure Git rename remains explicit. */
export const renameOnlyValue = "unchanged";
`;

const STATUS_ADDED_SOURCE = `export function statusAdded(): string {
  return "added-by-status-transaction";
}
`;
