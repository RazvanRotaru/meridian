/**
 * Structural pass: synthesize package nodes from directory segments, one module node per
 * source file, then recurse declarations. Produces descriptors in parent-before-child order
 * plus a file-path -> module index the edge pass uses for top-level call sources.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import type { SourceFile } from "ts-morph";
import { moduleDescriptor, packageDescriptor } from "./descriptor-factory";
import { emitContainer, type EmitContext } from "./member-emit";
import type { NodeDescriptor } from "./model";
import { posixDirname } from "./paths";
import type { LoadedProject } from "./project-loader";

/** Tags a `package` node whose directory holds a package.json — i.e. the owning npm package root. */
const NPM_PACKAGE_TAG = "npm-package";

export interface StructuralResult {
  descriptors: NodeDescriptor[];
  moduleByFilePath: Map<string, NodeDescriptor>;
}

export function buildStructure(loaded: LoadedProject, lang: string): StructuralResult {
  const descriptors: NodeDescriptor[] = [];
  const emit = (descriptor: NodeDescriptor) => {
    descriptors.push(descriptor);
    return descriptor;
  };
  const relativePaths = loaded.sourceFiles.map(loaded.relativePathOf);
  const packageByPath = emitPackages(relativePaths, loaded.root, lang, emit, loaded.memberPaths);
  const moduleByFilePath = emitModules(loaded, lang, packageByPath, emit);
  return { descriptors, moduleByFilePath };
}

function emitPackages(
  relativePaths: string[],
  root: string,
  lang: string,
  emit: (descriptor: NodeDescriptor) => NodeDescriptor,
  memberPaths: ReadonlySet<string> | undefined,
): Map<string, NodeDescriptor> {
  const byPath = new Map<string, NodeDescriptor>();
  for (const packagePath of orderedPackagePaths(relativePaths)) {
    const parent = byPath.get(posixDirname(packagePath)) ?? null;
    const descriptor = tagNpmPackage(packageDescriptor(lang, packagePath, parent), root, packagePath, memberPaths);
    byPath.set(packagePath, emit(descriptor));
  }
  return byPath;
}

/**
 * Mark a package node as an npm-package BOUNDARY (the overview's package cards). When the repo's
 * manifests declared a member set, ONLY those dirs are boundaries — so a package.json nested inside a
 * member (scaffolding, generated tools) folds into the member instead of splitting off its own card,
 * and a workspace-root container (its members ARE the boundaries) stays transparent. Absent a member
 * set (a plain package), fall back to "any dir with a package.json".
 */
function tagNpmPackage(
  descriptor: NodeDescriptor,
  root: string,
  packagePath: string,
  memberPaths: ReadonlySet<string> | undefined,
): NodeDescriptor {
  const isBoundary = memberPaths
    ? memberPaths.has(packagePath)
    : existsSync(join(root, packagePath, "package.json"));
  if (isBoundary) {
    descriptor.tags = [...descriptor.tags, NPM_PACKAGE_TAG];
  }
  return descriptor;
}

function emitModules(
  loaded: LoadedProject,
  lang: string,
  packageByPath: Map<string, NodeDescriptor>,
  emit: (descriptor: NodeDescriptor) => NodeDescriptor,
): Map<string, NodeDescriptor> {
  const moduleByFilePath = new Map<string, NodeDescriptor>();
  for (const sourceFile of loaded.sourceFiles) {
    const relPath = loaded.relativePathOf(sourceFile);
    const context = { lang, modulePath: relPath, relPath };
    const parent = packageByPath.get(posixDirname(relPath)) ?? null;
    const moduleNode = emit(moduleDescriptor(context, sourceFile, parent));
    moduleByFilePath.set(sourceFile.getFilePath(), moduleNode);
    recurseModule(sourceFile, moduleNode, { ...context, emit });
  }
  return moduleByFilePath;
}

function recurseModule(sourceFile: SourceFile, moduleNode: NodeDescriptor, context: EmitContext): void {
  emitContainer(sourceFile, moduleNode, [], context);
}

/** Every directory between the root and a module becomes a package, shallow ones first. */
function orderedPackagePaths(relativePaths: string[]): string[] {
  const paths = new Set<string>();
  for (const relativePath of relativePaths) {
    addAncestors(posixDirname(relativePath), paths);
  }
  return [...paths].sort(byDepthThenName);
}

function addAncestors(directory: string, paths: Set<string>): void {
  let accumulated = "";
  for (const segment of directory.split("/").filter(Boolean)) {
    accumulated = accumulated ? `${accumulated}/${segment}` : segment;
    paths.add(accumulated);
  }
}

function byDepthThenName(left: string, right: string): number {
  const depth = left.split("/").length - right.split("/").length;
  return depth !== 0 ? depth : left.localeCompare(right);
}
