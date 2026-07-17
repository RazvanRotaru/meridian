/**
 * Pure parsing of api.github.com JSON into narrow, whitelisted shapes the browser is allowed to
 * see. Repo names and descriptions are attacker-controllable, so nothing here forwards raw
 * response fields — only these typed projections leave the server, and only over `textContent`.
 */

import type { ChangedDiffLine, ChangedLineSpan, LineRange } from "@meridian/core";
import { parseUnifiedDiffBody, type UnifiedDiffEdit } from "../unified-diff";
import { asObject, numberOr, optionalString, requireNumber, requireString } from "./json-fields";
import { isAllowedBranchRef } from "./git-ref";
import { WebError } from "./web-error";

const OWNER_REPO = /^[\w.-]+\/[\w.-]+$/;
const SEARCH_RESULT_LIMIT = 20;
const BRANCH_RESULT_LIMIT = 100;
/** One full page of `GET /user/repos` — the pagination loop in github.ts caps the total. */
const LIST_RESULT_LIMIT = 100;
const PR_LIST_RESULT_LIMIT = 30;
const PR_FILE_RESULT_LIMIT = 100;
const PR_COMMENT_RESULT_LIMIT = 100;
const PR_REVIEW_RESULT_LIMIT = 100;
const CHECK_RUN_RESULT_LIMIT = 100;
const PR_BODY_LIMIT = 10_000;
const PR_COMMENT_BODY_LIMIT = 2_000;
const REMOVED_LINE_LIMIT = 500;

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
  body: string | null;
  author: string;
  headRef: string;
  headSha: string | null;
  baseRef: string;
  updatedAt: string;
  draft: boolean;
  state: "open" | "closed";
  url: string;
  viewerStatus?: PrViewerStatus;
}

export type PrViewerReview = "approved" | "changes_requested" | "commented" | "dismissed";

export interface PrViewerStatus {
  reviewRequested: boolean;
  review: PrViewerReview | null;
}

export interface PrGitHubComment {
  id: number;
  inReplyToId: number | null;
  path: string;
  line: number | null;
  side: "LEFT" | "RIGHT" | null;
  body: string;
  author: string;
  updatedAt: string;
  url: string;
}

export interface PrReviewRollup {
  approved: string[];
  changesRequested: string[];
  commented: number;
}

export interface PrDiscussionResult {
  comments: PrGitHubComment[];
  reviews: PrReviewRollup;
  hasMore: boolean;
}

export interface PrChecks {
  total: number;
  passed: number;
  failed: number;
  pending: number;
  url: string | null;
}

/** One exact edit run's old/new spans, using next-row cursor coordinates for an empty side. */
export type LineEdit = UnifiedDiffEdit;

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
  /** Per-edit-run old/new spans, for mapping a node's base span to its position in the PR head file. */
  edits?: LineEdit[];
  /** New-side context ranges from GitHub's original U3 hunk headers, used only for commentability. */
  contextHunks?: LineRange[];
  /** Head-relative added/modified line spans, read from the patch BODY (not the context-padded hunk
   * header), so the code panel paints exactly the changed lines green/gold — not the whole hunk. */
  kinds?: ChangedLineSpan[];
  /** Exact ordered +/- rows from the same canonical parser used by local git diffs. */
  diffLines?: ChangedDiffLine[];
  /** Whether the supplied patch is internally complete and matches GitHub's file-level totals. */
  diffComplete?: boolean;
  /** Removed patch text grouped by deletion run and anchored after the preceding HEAD-side line. */
  removed?: Array<{ afterNewLine: number; lines: string[] }>;
  /** True when `removed` reached its per-file safety cap. */
  removedTruncated?: boolean;
  /** Renames only: the pre-image path. */
  previousPath?: string;
}

export type RepoQuery =
  | { kind: "exact"; owner: string; repo: string }
  | { kind: "search"; term: string };

export interface RepoSlug {
  owner: string;
  repo: string;
}

/** Strictly normalize an owner/repo slug or github.com repository URL. */
export function parseRepoSlug(raw: string): RepoSlug | null {
  return repoSlug(raw.trim());
}

/** An `owner/repo` (or github URL) becomes a direct lookup; anything else is a fuzzy search. */
export function classifyQuery(raw: string): RepoQuery | null {
  const term = raw.trim();
  if (term.length === 0) {
    return null;
  }
  const slug = parseRepoSlug(term);
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

/** A single GitHub branches page, restricted to refs accepted by the repository fetch path. */
export function parseBranchList(json: unknown): string[] {
  if (!Array.isArray(json)) {
    return [];
  }
  const branches: string[] = [];
  for (const item of json.slice(0, BRANCH_RESULT_LIMIT)) {
    const name = optionalString(asObject(item), "name");
    if (name && isAllowedBranchRef(name)) {
      branches.push(name);
    }
  }
  return branches;
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

export function parsePullRequestComments(json: unknown): PrGitHubComment[] {
  if (!Array.isArray(json)) {
    return [];
  }
  return json.slice(0, PR_COMMENT_RESULT_LIMIT).map((item) => {
    const comment = asObject(item);
    const line = comment.line;
    const side = comment.side;
    const inReplyToId = comment.in_reply_to_id;
    return {
      id: positiveIntegerOrThrow(comment.id, "id"),
      inReplyToId: positiveIntegerOrNull(inReplyToId),
      path: requireString(comment, "path"),
      line: typeof line === "number" && Number.isSafeInteger(line) && line > 0 ? line : null,
      side: side === "LEFT" || side === "RIGHT" ? side : null,
      body: requireString(comment, "body").slice(0, PR_COMMENT_BODY_LIMIT),
      author: requireString(asObject(comment.user ?? {}), "login"),
      updatedAt: requireString(comment, "updated_at"),
      url: httpsOrNull(optionalString(comment, "html_url")) ?? "",
    };
  });
}

function positiveIntegerOrThrow(value: unknown, key: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw new WebError(502, `GitHub response missing positive integer '${key}'`);
  }
  return value;
}

function positiveIntegerOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : null;
}

/** Latest submitted state per author. A dismissal removes that author's prior state from the rollup. */
export function parsePullRequestReviews(json: unknown): PrReviewRollup {
  if (!Array.isArray(json)) {
    return { approved: [], changesRequested: [], commented: 0 };
  }
  const ordered = json
    .slice(0, PR_REVIEW_RESULT_LIMIT)
    .map((item, position) => {
      const review = asObject(item);
      const state = review.state;
      const submittedAt = optionalString(review, "submitted_at");
      const author = optionalString(asObject(review.user ?? {}), "login");
      if (!author || !submittedAt || !isReviewState(state)) {
        return null;
      }
      return { author, state, submittedAt, position };
    })
    .filter((review): review is NonNullable<typeof review> => review !== null)
    .sort((left, right) => left.submittedAt.localeCompare(right.submittedAt) || left.position - right.position);
  const latest = new Map<string, (typeof ordered)[number]>();
  for (const review of ordered) {
    if (review.state === "DISMISSED") {
      latest.delete(review.author);
    } else {
      latest.set(review.author, review);
    }
  }
  const states = [...latest.values()].sort(
    (left, right) => left.submittedAt.localeCompare(right.submittedAt) || left.position - right.position,
  );
  return {
    approved: states.filter((review) => review.state === "APPROVED").map((review) => review.author),
    changesRequested: states.filter((review) => review.state === "CHANGES_REQUESTED").map((review) => review.author),
    commented: states.filter((review) => review.state === "COMMENTED").length,
  };
}

export function parseCheckRuns(json: unknown): PrChecks {
  const runs = asObject(json).check_runs;
  if (!Array.isArray(runs)) {
    return { total: 0, passed: 0, failed: 0, pending: 0, url: null };
  }
  let passed = 0;
  let failed = 0;
  let pending = 0;
  let failedUrl: string | null = null;
  const capped = runs.slice(0, CHECK_RUN_RESULT_LIMIT);
  for (const item of capped) {
    const run = asObject(item);
    const status = optionalString(run, "status");
    const conclusion = optionalString(run, "conclusion");
    if (status !== "completed" || conclusion === null) {
      pending += 1;
    } else if (conclusion === "success" || conclusion === "neutral" || conclusion === "skipped") {
      passed += 1;
    } else {
      failed += 1;
      if (failed === 1) {
        failedUrl = httpsOrNull(optionalString(run, "html_url"));
      }
    }
  }
  return { total: capped.length, passed, failed, pending, url: failedUrl };
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
    .replace(/\/$/, "")
    .replace(/\.git$/, "");
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

export function toPrSummary(body: Record<string, unknown>): PrSummary {
  const rawBody = optionalString(body, "body")?.trim().slice(0, PR_BODY_LIMIT) ?? "";
  const head = asObject(body.head ?? {});
  return {
    number: Math.trunc(requireNumber(body, "number")),
    title: requireString(body, "title"),
    body: rawBody.length > 0 ? rawBody : null,
    author: requireString(asObject(body.user ?? {}), "login"),
    headRef: requireString(head, "ref"),
    headSha: optionalString(head, "sha"),
    baseRef: optionalString(asObject(body.base ?? {}), "ref") ?? "",
    updatedAt: requireString(body, "updated_at"),
    draft: body.draft === true,
    state: body.state === "closed" ? "closed" : "open",
    url: httpsOrNull(optionalString(body, "html_url")) ?? "",
  };
}

function isReviewState(value: unknown): value is "APPROVED" | "CHANGES_REQUESTED" | "COMMENTED" | "DISMISSED" {
  return value === "APPROVED" || value === "CHANGES_REQUESTED" || value === "COMMENTED" || value === "DISMISSED";
}

function toPrFile(body: Record<string, unknown>): PrFile {
  const file: PrFile = {
    path: requireString(body, "filename"),
    status: prFileStatus(body.status),
    additions: Math.max(0, Math.trunc(numberOr(body.additions, 0))),
    deletions: Math.max(0, Math.trunc(numberOr(body.deletions, 0))),
  };
  const previousPath = optionalString(body, "previous_filename");
  if (file.status === "renamed" && previousPath) {
    file.previousPath = previousPath;
  }
  const patch = optionalString(body, "patch");
  if (patch) {
    const detail = parsePatchDetail(patch);
    const verified = detail.complete && detail.added === file.additions && detail.deleted === file.deletions;
    file.diffComplete = verified;
    // Fail closed: a partial GitHub patch must never look authoritative. Omitting all derived detail
    // makes downstream use its existing whole-file fallback instead of rendering a plausible subset.
    if (verified) {
      if (detail.hunks.length > 0) {
        file.hunks = detail.hunks;
      }
      if (detail.oldHunks.length > 0) {
        file.oldHunks = detail.oldHunks;
      }
      if (detail.edits.length > 0) {
        file.edits = detail.edits;
      }
      if (detail.contextHunks.length > 0) {
        file.contextHunks = detail.contextHunks;
      }
      if (detail.kinds.length > 0) {
        file.kinds = detail.kinds;
      }
      if (detail.diffLines.length > 0) {
        file.diffLines = detail.diffLines;
      }
      if (detail.removed.length > 0) {
        file.removed = detail.removed;
      }
      if (detail.removedTruncated) {
        file.removedTruncated = true;
      }
    }
  } else {
    // GitHub omits `patch` for binary files and may omit it for oversized textual diffs. Treat the
    // absence as explicitly incomplete so every source host explains that it has metadata only,
    // instead of silently presenting unchanged code as though no +/- rows existed.
    file.diffComplete = false;
  }
  return file;
}

/**
 * New-side context ranges from unified-diff hunk headers (`@@ -a,b +c,d @@`): `c` is the new-side
 * start and `d` the count (absent ⇒ 1). Empty new-side ranges are omitted: there is no RIGHT-side
 * line GitHub can accept a review comment on. Ranges are 1-based and inclusive.
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
    if (Number.isSafeInteger(start) && Number.isSafeInteger(count) && start >= 1 && count >= 1) {
      ranges.push({ start, end: start + count - 1 });
    }
  }
  return ranges;
}

export interface PatchDetail {
  /** New-side TIGHT changed ranges for head-graph marking. */
  hunks: LineRange[];
  /** Old-side (BASE) tight changed ranges — base-graph node marking. Because the synchronous review
   * overlays the diff on the BASE graph (whose node line numbers are base-side), a new-side range
   * that shifted down when earlier lines were added would numerically spill onto the NEXT unchanged
   * declaration; the old-side range can't, so only genuinely-changed base nodes mark. */
  oldHunks: LineRange[];
  edits: LineEdit[];
  /** Context-padded new-side U3 ranges, retained solely for GitHub review-comment validation. */
  contextHunks: LineRange[];
  kinds: ChangedLineSpan[];
  diffLines: ChangedDiffLine[];
  added: number;
  deleted: number;
  complete: boolean;
  /** Removed patch text, one entry per contiguous deletion run, positioned in HEAD coordinates. */
  removed: Array<{ afterNewLine: number; lines: string[] }>;
  /** True when more than REMOVED_LINE_LIMIT deleted lines were present in this file's patch. */
  removedTruncated: boolean;
}

/**
 * A GitHub PR `patch` carries CONTEXT lines (the default `-U3`), so the hunk HEADER range covers
 * more than the edit — marking nodes off it spills into the next declaration. This walks the hunk
 * BODY instead. The shared local/GitHub parser emits exact ordered +/- rows, per-run base→HEAD
 * edits, paintable HEAD kinds, and tight old/new graph ranges. Header context survives separately
 * as `contextHunks`, solely for GitHub review-comment validation.
 */
export function parsePatchDetail(patch: string): PatchDetail {
  const parsed = parseUnifiedDiffBody(patch);
  const { removed, removedTruncated } = removedFromDiffLines(parsed.diffLines);
  return {
    hunks: parsed.ranges,
    oldHunks: parsed.oldRanges,
    edits: parsed.edits,
    contextHunks: parsePatchHunks(patch),
    kinds: parsed.kinds,
    diffLines: parsed.diffLines,
    added: parsed.added,
    deleted: parsed.deleted,
    complete: parsed.complete,
    removed,
    removedTruncated,
  };
}

function removedFromDiffLines(diffLines: readonly ChangedDiffLine[]): {
  removed: Array<{ afterNewLine: number; lines: string[] }>;
  removedTruncated: boolean;
} {
  const removed: Array<{ afterNewLine: number; lines: string[] }> = [];
  let active: { afterNewLine: number; lines: string[] } | null = null;
  let captured = 0;
  let removedTruncated = false;
  for (const row of diffLines) {
    if (row.kind !== "deleted") {
      active = null;
      continue;
    }
    if (captured >= REMOVED_LINE_LIMIT) {
      removedTruncated = true;
      continue;
    }
    const afterNewLine = row.beforeNewLine - 1;
    if (active === null || active.afterNewLine !== afterNewLine) {
      active = { afterNewLine, lines: [] };
      removed.push(active);
    }
    active.lines.push(row.text);
    captured += 1;
  }
  return { removed, removedTruncated };
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
