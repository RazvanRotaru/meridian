/**
 * The change-status vocabulary for PR-review, plus the parsing/serialization that carries it from a
 * reader's paste (plain paths OR `git diff --name-status` lines) through the URL and back. A REMOVED
 * file has no node at HEAD, so status rides ALONGSIDE the path list — never on a graph node. Pure; no
 * React, no store. Reuses `normalizePath` so every path lands in the same normalized form.
 */

import { normalizePath } from "./matchAffectedFiles";

/** How a file changed in the PR. "modified" is the default when a paste carries no status token. */
export type ChangeStatus = "added" | "modified" | "removed" | "renamed";

export interface ParsedAffectedInput {
  /** Normalized changed-file paths, in paste order (for a rename, the NEW path). */
  paths: string[];
  /** Per-file status keyed by normalized path; an absent entry == "modified". */
  statusByFile: Record<string, ChangeStatus>;
}

/** git's single-letter codes -> our vocabulary. C[opied] lands a fresh file at HEAD, so "added". */
const STATUS_BY_CODE: Record<string, ChangeStatus> = { A: "added", M: "modified", D: "removed", R: "renamed", C: "added" };

/** A `git diff --name-status` line: a code (A|M|D|R|C) + optional score, whitespace/tab, then path(s). */
const NAME_STATUS = /^([AMDRC])(\d+)?[ \t]+(.+)$/;

/**
 * Parse pasted input that is EITHER plain paths (one per line -> "modified") OR
 * `git diff --name-status` lines. For a rename/copy line ("R100\told\tnew") the NEW path wins.
 * Blank lines are ignored; every path is normalized (backslash -> "/", leading "./" stripped).
 */
export function parseAffectedInput(text: string): ParsedAffectedInput {
  const paths: string[] = [];
  const statusByFile: Record<string, ChangeStatus> = {};
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (line.length === 0) {
      continue;
    }
    const { path, status } = parseLine(line);
    const normalized = normalizePath(path);
    if (normalized.length === 0) {
      continue;
    }
    paths.push(normalized);
    statusByFile[normalized] = status;
  }
  return { paths, statusByFile };
}

/** One line -> path + status. A name-status match wins; anything else is a plain "modified" path. */
function parseLine(line: string): { path: string; status: ChangeStatus } {
  const match = NAME_STATUS.exec(line);
  if (!match) {
    return { path: line, status: "modified" };
  }
  const status = STATUS_BY_CODE[match[1]] ?? "modified";
  const path = status === "renamed" ? renameTarget(match[3]) : match[3].trim();
  return { path, status };
}

/** A rename/copy carries "old\tnew" (tab-separated); the NEW (last) segment is the file at HEAD. */
function renameTarget(rest: string): string {
  const parts = rest.split("\t").map((part) => part.trim()).filter(Boolean);
  return parts[parts.length - 1] ?? rest.trim();
}

/** Prefixes that mark a non-modified status in the compact `files` URL param. */
const PREFIX_BY_STATUS: Partial<Record<ChangeStatus, string>> = { added: "a:", removed: "d:", renamed: "r:" };
const STATUS_BY_PREFIX: Record<string, ChangeStatus> = { "a:": "added", "d:": "removed", "r:": "renamed" };

/**
 * Encode paths for the `files` URL param, comma-joined. A non-modified status gets a short prefix
 * ("a:"/"d:"/"r:"); "modified" has NONE, so a legacy `?files=a,b` link stays byte-identical.
 */
export function encodeFilesParam(paths: string[], statusByFile: Record<string, ChangeStatus>): string {
  return paths
    .map((path) => {
      const prefix = PREFIX_BY_STATUS[statusByFile[path] ?? "modified"];
      return prefix ? `${prefix}${path}` : path;
    })
    .join(",");
}

/** Decode the `files` param to paths + status; a prefixless entry is "modified" (no map entry). */
export function parseFilesParam(param: string): ParsedAffectedInput {
  const paths: string[] = [];
  const statusByFile: Record<string, ChangeStatus> = {};
  for (const entry of param.split(",").filter(Boolean)) {
    const status = STATUS_BY_PREFIX[entry.slice(0, 2)];
    const path = normalizePath(status ? entry.slice(2) : entry);
    if (path.length === 0) {
      continue;
    }
    paths.push(path);
    if (status) {
      statusByFile[path] = status;
    }
  }
  return { paths, statusByFile };
}
