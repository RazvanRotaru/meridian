/**
 * Pipeline pieces shared by the two extraction modes: single-project (extractor.ts) and
 * per-package (extract-per-package.ts). Kept apart so neither mode imports the other.
 */

import type { SourceFile } from "ts-morph";
import type { ExtractionDiagnostic, Port } from "@meridian/core";
import type { EdgeBuildResult } from "./edge-build";
import type { NodeDescriptor } from "./model";
import type { LoadedProject } from "./project-loader";

export const NODE_ID_LANGUAGE = "ts";

/**
 * A port must reference a SURVIVING node: when `--depth` collapsed the owning callable away,
 * reattribute the port to its file's module node (which survives at every depth above package).
 */
export function portsWithin(
  ports: Port[],
  keepIds: ReadonlySet<string>,
  moduleIdByRelPath: ReadonlyMap<string, string>,
): Port[] {
  return ports
    .map((port) => (keepIds.has(port.nodeId) ? port : { ...port, nodeId: moduleIdByRelPath.get(port.callSite.file) ?? "" }))
    .filter((port) => keepIds.has(port.nodeId));
}

/** Root-relative file path -> its module node id, for port reattribution and the join. */
export function moduleIdsByRelPath(loaded: LoadedProject, moduleByFilePath: Map<string, NodeDescriptor>): Map<string, string> {
  const byRelPath = new Map<string, string>();
  for (const sourceFile of loaded.sourceFiles) {
    const moduleNode = moduleByFilePath.get(sourceFile.getFilePath());
    if (moduleNode) {
      byRelPath.set(loaded.relativePathOf(sourceFile), moduleNode.finalId);
    }
  }
  return byRelPath;
}

/**
 * Key each surviving module's SourceFile by its node id, so the flow pass can chart the
 * module's load-time top-level statements. Descriptors carry no SourceFile; we match by path.
 */
export function moduleSourcesById(
  loaded: LoadedProject,
  moduleByFilePath: Map<string, NodeDescriptor>,
): Map<string, SourceFile> {
  const byId = new Map<string, SourceFile>();
  for (const sourceFile of loaded.sourceFiles) {
    const moduleNode = moduleByFilePath.get(sourceFile.getFilePath());
    if (moduleNode) {
      byId.set(moduleNode.finalId, sourceFile);
    }
  }
  return byId;
}

export function appendDropDiagnostics(diagnostics: ExtractionDiagnostic[], built: EdgeBuildResult): void {
  if (built.externalCallsDropped > 0) {
    diagnostics.push({ severity: "warn", message: `dropped ${built.externalCallsDropped} external call edge(s)` });
  }
  if (built.unresolvedCalls > 0) {
    diagnostics.push({ severity: "warn", message: `${built.unresolvedCalls} unresolved call(s)` });
  }
}
