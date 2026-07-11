/**
 * Pure parsing of api.github.com JSON into narrow, whitelisted shapes the browser is allowed to
 * see. Repo names and descriptions are attacker-controllable, so nothing here forwards raw
 * response fields — only these typed projections leave the server, and only over `textContent`.
 */

import type { ChangedLineSpan, LineRange } from "@meridian/core";
import { asObject, numberOr, optionalString, requireNumber, requireString } from "./json-fields";

const OWNER_REPO = /^[\w.-]+\/[\w.-]+$/;
const SEARCH_RESULT_LIMIT = 20;
/** One full page of `GET /user/repos` — the pagination loop in github.ts caps the total. */
const LIST_RESULT_LIMIT = 100;
const PR_LIST_RESULT_LIMIT = 30;
const PR_FILE_RESULT_LIMIT = 100;

export interface RepoSummary {
  fullName: string;
  isPrivate: boolean;
  defaultBranch: string | null;
  description: string | null;
  ownerAvatarUrl: string | null;
}

export interface GitHubUser {
  login: string;
  avatarUrl: string | null;
}

export interface PrSummary {
  number: number;
  title: string;
  author: string;
  headRef: string;
  baseRef: string;
  updatedAt: string;
  draft: boolean;
  state: "open" | "closed";
  url: string;
}

/** One unified-diff hunk's old/new line spans — enough to map a base line number to its head line. */
export interface LineEdit {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
}

export interface PrFile {
  path: string;
  status: "added" | "modified" | "removed" | "renamed";
  additions: number;
  deletions: number;
  /** New-side changed line ranges parsed from the file's unified-diff patch; omitted when GitHub
   * ships no patch (binary, or a diff too large to include) ⇒ downstream treats the whole file as
   * changed. Lets the PR-review graph name the exact code blocks a PR touched, not just the files. */
  hunks?: LineRange[];
  /** Base-side (old) tight changed ranges — the base-graph node marking uses these so a shifted
   * new-side hunk can't spill onto the next unchanged declaration in base coordinates. */
  oldHunks?: LineRange[];
  /** Per-hunk old/new spans, for mapping a node's base span to its position in the PR head file. */
  edits?: LineEdit[];
  /** Head-relative added/modified line spans, read from the patch BODY (not the context-padded hunk
   * header), so the code panel paints exactly the changed lines green/gold — not the whole hunk. */
  kinds?: ChangedLineSpan[];
}

export type RepoQuery =
  | { kind: "exact"; owner: string; repo: string }
  | { kind: "search"; term: string };

/** An `owner/repo` (or github URL) becomes a direct lookup; anything else is a fuzzy search. */
export function classifyQuery(raw: string): RepoQuery | null {
  const term = raw.trim();
  if (term.length === 0) {
    return null;
  }
  const slug = repoSlug(term);
  if (slug) {
    return { kind: "exact", owner: slug.owner, repo: slug.repo };
  }
  return { kind: "search", term };
}

export function parseRepoResult(json: unknown): RepoSummary {
  return toRepoSummary(asObject(json));
}

export function parseSearchResults(json: unknown): RepoSummary[] {
  const items = asObject(json).items;
  if (!Array.isArray(items)) {
    return [];
  }
  return items.slice(0, SEARCH_RESULT_LIMIT).map((item) => toRepoSummary(asObject(item)));
}

/** `GET /user/repos` responds with a bare array, not search's `{items}` envelope. */
export function parseRepoList(json: unknown): RepoSummary[] {
  if (!Array.isArray(json)) {
    return [];
  }
  return json.slice(0, LIST_RESULT_LIMIT).map((item) => toRepoSummary(asObject(item)));
}

export function parsePullRequestList(json: unknown): PrSummary[] {
  if (!Array.isArray(json)) {
    return [];
  }
  return json.slice(0, PR_LIST_RESULT_LIMIT).map((item) => toPrSummary(asObject(item)));
}

export function parsePullRequestFiles(json: unknown): PrFile[] {
  if (!Array.isArray(json)) {
    return [];
  }
  return json.slice(0, PR_FILE_RESULT_LIMIT).map((item) => toPrFile(asObject(item)));
}

export function parseUser(json: unknown): GitHubUser {
  const body = asObject(json);
  return { login: requireString(body, "login"), avatarUrl: httpsOrNull(optionalString(body, "avatar_url")) };
}

/** The created review, whitelisted to the one field the browser shows: its html_url (or null). */
export function parseReviewSubmitted(json: unknown): { url: string | null } {
  return { url: httpsOrNull(optionalString(asObject(json), "html_url")) };
}

function repoSlug(term: string): { owner: string; repo: string } | null {
  const stripped = term
    .replace(/^https?:\/\/github\.com\//i, "")
    .replace(/\.git$/, "")
    .replace(/\/$/, "");
  if (!OWNER_REPO.test(stripped)) {
    return null;
  }
  const [owner, repo] = stripped.split("/");
  return { owner, repo };
}

function toRepoSummary(body: Record<string, unknown>): RepoSummary {
  const owner = asObject(body.owner ?? {});
  return {
    fullName: requireString(body, "full_name"),
    isPrivate: body.private === true,
    defaultBranch: optionalString(body, "default_branch"),
    description: optionalString(body, "description"),
    ownerAvatarUrl: httpsOrNull(optionalString(owner, "avatar_url")),
  };
}

function toPrSummary(body: Record<string, unknown>): PrSummary {
  return {
    number: Math.trunc(requireNumber(body, "number")),
    title: requireString(body, "title"),
    author: requireString(asObject(body.user ?? {}), "login"),
    headRef: requireString(asObject(body.head ?? {}), "ref"),
    baseRef: optionalString(asObject(body.base ?? {}), "ref") ?? "",
    updatedAt: requireString(body, "updated_at"),
    draft: body.draft === true,
    state: body.state === "closed" ? "closed" : "open",
    url: httpsOrNull(optionalString(body, "html_url")) ?? "",
  };
}

function toPrFile(body: Record<string, unknown>): PrFile {
  const file: PrFile = {
    path: requireString(body, "filename"),
    status: prFileStatus(body.status),
    additions: Math.max(0, Math.trunc(numberOr(body.additions, 0))),
    deletions: Math.max(0, Math.trunc(numberOr(body.deletions, 0))),
  };
  const patch = optionalString(body, "patch");
  if (patch) {
    const detail = parsePatchDetail(patch);
    if (detail.hunks.length > 0) {
      file.hunks = detail.hunks;
    }
    if (detail.oldHunks.length > 0) {
      file.oldHunks = detail.oldHunks;
    }
    if (detail.edits.length > 0) {
      file.edits = detail.edits;
    }
    if (detail.kinds.length > 0) {
      file.kinds = detail.kinds;
    }
  }
  return file;
}

/**
 * New-side changed line ranges from a unified-diff patch, read from its hunk headers alone
 * (`@@ -a,b +c,d @@`): `c` is the new-side start, `d` the line count (absent ⇒ 1). A `+c,0` header
 * is a pure deletion — anchored to a 1-line span at `c` so a delete-only edit still names the block
 * it sits in (mirrors the local `meridian review` diff parser). Ranges are 1-based and inclusive.
 */
export function parsePatchHunks(patch: string): LineRange[] {
  const ranges: LineRange[] = [];
  for (const line of patch.split("\n")) {
    const match = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (!match) {
      continue;
    }
    const start = Number(match[1]);
    const count = match[2] === undefined ? 1 : Number(match[2]);
    ranges.push(count === 0 ? { start, end: start + 1 } : { start, end: start + count - 1 });
  }
  return ranges;
}

export interface PatchDetail {
  /** New-side TIGHT changed ranges — code-panel head paint + review-comment anchoring + head-graph
   * marking. */
  hunks: LineRange[];
  /** Old-side (BASE) tight changed ranges — base-graph node marking. Because the synchronous review
   * overlays the diff on the BASE graph (whose node line numbers are base-side), a new-side range
   * that shifted down when earlier lines were added would numerically spill onto the NEXT unchanged
   * declaration; the old-side range can't, so only genuinely-changed base nodes mark. */
  oldHunks: LineRange[];
  edits: LineEdit[];
  kinds: ChangedLineSpan[];
}

/**
 * A GitHub PR `patch` carries CONTEXT lines (the default `-U3`), so the hunk HEADER range covers
 * more than the edit — marking nodes off it spills into the next declaration. This walks the hunk
 * BODY instead, tracking BOTH the new- and old-side line counters, and emits, per contiguous run of
 * additions/deletions, TIGHT changed-line spans: `kinds` (new-side, tagged modified/added, code
 * panel), `hunks` (new-side, comments + head-graph marking) and `oldHunks` (base-side, base-graph
 * marking — see the interface). `edits` records each hunk's old/new spans for base→head mapping.
 * 1-based, inclusive.
 */
export function parsePatchDetail(patch: string): PatchDetail {
  const hunks: LineRange[] = [];
  const oldHunks: LineRange[] = [];
  const edits: LineEdit[] = [];
  const kinds: ChangedLineSpan[] = [];
  let newLine = 0;
  let oldLine = 0;
  let inHunk = false;
  let addRun: number[] = []; // new-side line numbers of the current contiguous `+` run
  let delRun: number[] = []; // old-side (base) line numbers of the current contiguous `-` run
  const flush = () => {
    if (addRun.length > 0) {
      const span = { start: addRun[0], end: addRun[addRun.length - 1] };
      kinds.push({ ...span, kind: delRun.length > 0 ? "modified" : "added" });
      hunks.push(span);
    } else if (delRun.length > 0) {
      // Pure deletion: no head line to paint, but the node it sat in changed — new-side seam at the
      // line the removed block now precedes.
      hunks.push({ start: Math.max(newLine, 1), end: Math.max(newLine, 1) });
    }
    // Base-side marking range: deleted/modified base lines, or a seam at the base insertion point.
    if (delRun.length > 0) {
      oldHunks.push({ start: delRun[0], end: delRun[delRun.length - 1] });
    } else if (addRun.length > 0) {
      oldHunks.push({ start: Math.max(oldLine, 1), end: Math.max(oldLine, 1) });
    }
    addRun = [];
    delRun = [];
  };
  for (const raw of patch.split("\n")) {
    const header = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(raw);
    if (header) {
      flush();
      const oldStart = Number(header[1]);
      const oldLines = header[2] === undefined ? 1 : Number(header[2]);
      const newStart = Number(header[3]);
      const newLines = header[4] === undefined ? 1 : Number(header[4]);
      edits.push({ oldStart, oldLines, newStart, newLines });
      oldLine = oldStart;
      newLine = newStart;
      inHunk = true;
      continue;
    }
    if (!inHunk || raw.startsWith("\\")) {
      continue; // preamble (diff --git / ---/+++), or a "\ No newline at end of file" marker
    }
    const marker = raw[0];
    if (marker === "+") {
      addRun.push(newLine);
      newLine += 1;
    } else if (marker === "-") {
      delRun.push(oldLine);
      oldLine += 1;
    } else {
      flush(); // a context line ends any run
      oldLine += 1;
      newLine += 1;
    }
  }
  flush();
  return { hunks, oldHunks, edits, kinds };
}

function prFileStatus(status: unknown): PrFile["status"] {
  if (status === "added" || status === "modified" || status === "removed" || status === "renamed") {
    return status;
  }
  if (status === "copied") {
    return "added";
  }
  return "modified";
}

/** Only https URLs survive; a `javascript:`/`data:` avatar becomes null before it can be an src. */
function httpsOrNull(url: string | null): string | null {
  if (url === null) {
    return null;
  }
  try {
    return new URL(url).protocol === "https:" ? url : null;
  } catch {
    return null;
  }
}
