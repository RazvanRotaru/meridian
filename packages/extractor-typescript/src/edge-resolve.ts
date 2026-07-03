/**
 * Static call resolution, honestly classified. A callee expression resolves to `resolved`
 * (an in-graph node), `external` (a lib / node_modules / .d.ts declaration), or `unresolved`
 * (no symbol, or a symbol we did not emit). Every attempt is guarded — a thrown resolution
 * degrades to `unresolved` rather than aborting the pass.
 */

import { Node, type Symbol as TsSymbol } from "ts-morph";
import type { EdgeResolution } from "@meridian/core";
import { nodeKey } from "./model";
import { posixBasename } from "./paths";
import type { ResolutionIndex } from "./resolution-index";

export interface TargetResolution {
  resolution: EdgeResolution;
  resolvedTarget: string | null;
  externalModulePath: string | null;
  externalQualname: string | null;
  threw: boolean;
}

const UNRESOLVED: TargetResolution = {
  resolution: "unresolved",
  resolvedTarget: null,
  externalModulePath: null,
  externalQualname: null,
  threw: false,
};

export function resolveTarget(callee: Node, index: ResolutionIndex): TargetResolution {
  try {
    const symbol = aliasedSymbol(calleeSymbol(callee));
    const declaration = implementationDeclaration(symbol);
    if (!symbol || !declaration) {
      return UNRESOLVED;
    }
    return classifyDeclaration(declaration, symbol, index);
  } catch {
    return { ...UNRESOLVED, threw: true };
  }
}

function calleeSymbol(callee: Node): TsSymbol | undefined {
  if (Node.isPropertyAccessExpression(callee)) {
    return callee.getNameNode().getSymbol();
  }
  if (Node.isIdentifier(callee)) {
    return callee.getSymbol();
  }
  return undefined;
}

function aliasedSymbol(symbol: TsSymbol | undefined): TsSymbol | undefined {
  return symbol?.getAliasedSymbol() ?? symbol;
}

/** Prefer the body-bearing declaration (the implementation) over overload signatures. */
function implementationDeclaration(symbol: TsSymbol | undefined): Node | undefined {
  const declarations = symbol?.getDeclarations() ?? [];
  return declarations.find(hasBody) ?? declarations[0];
}

function hasBody(node: Node): boolean {
  return !!(node as { getBody?(): Node | undefined }).getBody?.();
}

function classifyDeclaration(declaration: Node, symbol: TsSymbol, index: ResolutionIndex): TargetResolution {
  if (isExternalDeclaration(declaration)) {
    return externalTo(declaration, symbol);
  }
  const resolvedTarget = index.targetByDeclKey.get(nodeKey(declaration));
  if (resolvedTarget) {
    return { resolution: "resolved", resolvedTarget, externalModulePath: null, externalQualname: null, threw: false };
  }
  return UNRESOLVED;
}

function isExternalDeclaration(declaration: Node): boolean {
  const filePath = declaration.getSourceFile().getFilePath();
  return filePath.includes("/node_modules/") || filePath.endsWith(".d.ts");
}

function externalTo(declaration: Node, symbol: TsSymbol): TargetResolution {
  return {
    resolution: "external",
    resolvedTarget: null,
    externalModulePath: externalModulePath(declaration),
    externalQualname: symbol.getName(),
    threw: false,
  };
}

function externalModulePath(declaration: Node): string {
  const filePath = declaration.getSourceFile().getFilePath();
  const marker = "/node_modules/";
  const at = filePath.lastIndexOf(marker);
  return at === -1 ? posixBasename(filePath) : filePath.slice(at + marker.length);
}
