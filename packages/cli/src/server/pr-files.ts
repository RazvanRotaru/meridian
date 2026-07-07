/**
 * Pure mapping of GitHub PR filenames (always repo-root-relative, forward-slashed) onto the
 * extraction root. When the graph was extracted from a subdir, the subdir prefix is stripped and
 * any file outside it is dropped, so the survivors line up with each node's `location.file`.
 */

/** Strip the extraction subdir prefix from PR filenames, dropping anything outside the subdir. */
export function stripSubdirPrefix(filenames: string[], subdir?: string): string[] {
  const prefix = normalizedPrefix(subdir);
  const stripped: string[] = [];
  for (const raw of filenames) {
    const file = normalizeSlashes(raw);
    if (!prefix) {
      if (file) {
        stripped.push(file);
      }
      continue;
    }
    if (file.startsWith(prefix)) {
      const rel = file.slice(prefix.length);
      if (rel) {
        stripped.push(rel);
      }
    }
  }
  return stripped;
}

function normalizedPrefix(subdir?: string): string {
  const clean = normalizeSlashes(subdir ?? "").replace(/^\/+/, "").replace(/\/+$/, "");
  return clean ? `${clean}/` : "";
}

function normalizeSlashes(path: string): string {
  return path.trim().replace(/\\/g, "/").replace(/^\.\//, "");
}
