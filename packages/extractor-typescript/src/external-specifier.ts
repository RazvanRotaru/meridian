/** Classify checker-missing bare imports from package manifests instead of guessing every typo. */

import { existsSync, readFileSync } from "node:fs";
import { builtinModules } from "node:module";
import { dirname, join } from "node:path";

const BUILTINS = new Set(builtinModules.flatMap((name) => [name, `node:${name}`]));
const DEPENDENCY_FIELDS = ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"] as const;

export type ExternalSpecifierMatcher = (fromFile: string, specifier: string) => boolean;

export function externalSpecifierMatcher(root: string): ExternalSpecifierMatcher {
  const dependenciesByDir = new Map<string, ReadonlySet<string>>();
  return (fromFile, specifier) => {
    if (BUILTINS.has(specifier) || hasExternalScheme(specifier)) {
      return true;
    }
    const packageName = packageNameOf(specifier);
    if (packageName === null) {
      return false;
    }
    let directory = dirname(fromFile);
    while (isWithin(directory, root)) {
      if (dependenciesIn(directory, dependenciesByDir).has(packageName)) {
        return true;
      }
      if (directory === root) {
        break;
      }
      directory = dirname(directory);
    }
    return false;
  };
}

function dependenciesIn(
  directory: string,
  cache: Map<string, ReadonlySet<string>>,
): ReadonlySet<string> {
  const cached = cache.get(directory);
  if (cached !== undefined) {
    return cached;
  }
  const dependencies = readDependencies(join(directory, "package.json"));
  cache.set(directory, dependencies);
  return dependencies;
}

function readDependencies(path: string): ReadonlySet<string> {
  if (!existsSync(path)) {
    return new Set();
  }
  try {
    const manifest = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    const names = DEPENDENCY_FIELDS.flatMap((field) => objectKeys(manifest[field]));
    return new Set(names);
  } catch {
    return new Set();
  }
}

function objectKeys(value: unknown): string[] {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? Object.keys(value as Record<string, unknown>)
    : [];
}

function packageNameOf(specifier: string): string | null {
  if (specifier.startsWith(".") || specifier.startsWith("/") || specifier.startsWith("#")) {
    return null;
  }
  const parts = specifier.split("/");
  return specifier.startsWith("@") ? (parts.length >= 2 ? `${parts[0]}/${parts[1]}` : null) : parts[0] || null;
}

function hasExternalScheme(specifier: string): boolean {
  return /^[a-z][a-z0-9+.-]*:/i.test(specifier);
}

function isWithin(directory: string, root: string): boolean {
  return directory === root || directory.startsWith(`${root}/`);
}
