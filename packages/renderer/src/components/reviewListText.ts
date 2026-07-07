/**
 * Pure text-formatting helpers for the PR-review list pane: a path's last segment, a
 * middle-truncated path for tight row widths, and the "calls into X (+k)" phrase for a
 * calls-into badge. No React, no store — kept separate so they're trivially unit-testable.
 */

const ELLIPSIS = "…";

/** The last `/`-segment of a path, or the whole string if it has none. */
export function basename(path: string): string {
  const i = path.lastIndexOf("/");
  return i === -1 ? path : path.slice(i + 1);
}

/**
 * Truncate `text` to at most `maxLength` chars, keeping its start and end and eliding the
 * middle — the readable choice for a file path, where both the leading directories and the
 * trailing filename carry meaning. Returns `text` unchanged when it already fits.
 */
export function middleTruncate(text: string, maxLength: number): string {
  if (text.length <= maxLength) {
    return text;
  }
  if (maxLength <= ELLIPSIS.length) {
    return text.slice(0, Math.max(0, maxLength));
  }
  const keep = maxLength - ELLIPSIS.length;
  const head = Math.ceil(keep / 2);
  const tail = Math.floor(keep / 2);
  return `${text.slice(0, head)}${ELLIPSIS}${tail > 0 ? text.slice(text.length - tail) : ""}`;
}

/** The calls-into badge phrase: the first affected file's basename, "+k" when there are more. */
export function callsIntoLabel(callsIntoFiles: readonly string[]): string {
  if (callsIntoFiles.length === 0) {
    return "calls into";
  }
  const first = basename(callsIntoFiles[0]);
  const extra = callsIntoFiles.length - 1;
  return extra > 0 ? `calls into ${first} +${extra}` : `calls into ${first}`;
}
