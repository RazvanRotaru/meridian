/**
 * Path helpers. Every locator the extractor emits is POSIX and relative to the
 * extraction root, so node ids stay machine-portable across checkouts.
 */

import { isAbsolute, relative, resolve } from "node:path";

export function toPosix(path: string): string {
  return path.replace(/\\/g, "/");
}

export function absoluteRoot(root: string): string {
  return toPosix(resolve(root));
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
