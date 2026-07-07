/**
 * Path helpers. Every locator the extractor emits is POSIX and relative to the
 * extraction root, so node ids stay machine-portable across checkouts.
 */

import { realpathSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";

export function toPosix(path: string): string {
  return path.replace(/\\/g, "/");
}

// canonicalize() expands Windows 8.3 short names (e.g. DARIA~1): ts-morph reports files under
// their long names, and a short-name root would make every file look outside the root.
export function absoluteRoot(root: string): string {
  return toPosix(canonicalize(resolve(root)));
}

function canonicalize(path: string): string {
  try {
    return realpathSync.native(path);
  } catch {
    return path; // nonexistent roots surface downstream as "no files matched", not a crash here
  }
}

export function relativeToRoot(absoluteRootPath: string, filePath: string): string {
  return toPosix(relative(absoluteRootPath, toPosix(filePath)));
}

export function isUnderRoot(relativePath: string): boolean {
  return relativePath.length > 0 && !relativePath.startsWith("..") && !isAbsolute(relativePath);
}

export function posixDirname(relativePath: string): string {
  const lastSlash = relativePath.lastIndexOf("/");
  return lastSlash === -1 ? "" : relativePath.slice(0, lastSlash);
}

export function posixBasename(relativePath: string): string {
  const lastSlash = relativePath.lastIndexOf("/");
  return lastSlash === -1 ? relativePath : relativePath.slice(lastSlash + 1);
}
