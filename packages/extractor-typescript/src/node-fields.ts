/**
 * Per-node field derivation: the doc summary, the syntactic signature, modifier tags, and
 * the OTel telemetry key. These read source syntax only (never the type checker) so the
 * structural pass stays fast.
 */

import { Node, type ParameterDeclaration } from "ts-morph";
import type { TelemetryKey } from "@meridian/core";

export interface SignatureLike {
  getParameters(): ParameterDeclaration[];
  getReturnTypeNode(): Node | undefined;
}

interface ModifierProbe {
  isExported?(): boolean;
  isAsync?(): boolean;
  isStatic?(): boolean;
  isAbstract?(): boolean;
  isReadonly?(): boolean;
  isGenerator?(): boolean;
  getScope?(): string;
}

export function summaryOf(node: Node): string | null {
  return jsDocSummary(node) ?? leadingLineSummary(node);
}

function jsDocSummary(node: Node): string | null {
  const docs = (node as { getJsDocs?(): Array<{ getDescription(): string }> }).getJsDocs?.();
  const description = docs?.at(-1)?.getDescription();
  return description ? firstSentence(description) : null;
}

function leadingLineSummary(node: Node): string | null {
  for (const range of node.getLeadingCommentRanges()) {
    const text = range.getText();
    if (text.startsWith("//")) {
      return firstSentence(text.replace(/^\/\/+\s?/, ""));
    }
  }
  return null;
}

/** Trim doc text to its first sentence; the renderer shows one line per node. */
function firstSentence(text: string): string {
  const trimmed = text.trim();
  const match = trimmed.match(/^[\s\S]*?[.!?](\s|$)/);
  return (match ? match[0] : trimmed).trim();
}

export function signatureOf(name: string, signature: SignatureLike | null): string | null {
  if (!signature) {
    return null;
  }
  const parameters = signature.getParameters().map(formatParameter).join(", ");
  const returnType = signature.getReturnTypeNode()?.getText();
  return `${name}(${parameters})${returnType ? `: ${returnType}` : ""}`;
}

function formatParameter(parameter: ParameterDeclaration): string {
  const typeNode = parameter.getTypeNode();
  return typeNode ? `${parameter.getName()}: ${typeNode.getText()}` : parameter.getName();
}

export function modifierTagsOf(node: Node): string[] {
  const probe = node as ModifierProbe;
  const tags: string[] = [];
  if (Node.isExportAssignment(node) || probe.isExported?.()) tags.push("export");
  if (probe.isAsync?.()) tags.push("async");
  if (probe.isStatic?.()) tags.push("static");
  if (probe.isAbstract?.()) tags.push("abstract");
  if (probe.isReadonly?.()) tags.push("readonly");
  const scope = probe.getScope?.();
  if (scope) tags.push(scope);
  return tags;
}

/** Exact syntax-level callable semantics. Ordinary async functions always return a Promise; async
 * generators do not, so retain the generator fact and never infer across that boundary. */
export function semanticTagsOf(node: Node): string[] {
  const signature = typeof (node as { getReturnTypeNode?: unknown }).getReturnTypeNode === "function"
    ? node as unknown as SignatureLike
    : null;
  return callableSemanticTagsOf([node], signature);
}

/** Merge declaration/container modifiers with the unwrapped callable and its chosen signature.
 * This keeps contextual/explicit Promise annotations as artifact facts while letting an async
 * generator veto the ordinary async=>Promise rule. */
export function callableSemanticTagsOf(
  sources: readonly Node[],
  signature: SignatureLike | null,
): string[] {
  const tags = sources.flatMap(modifierTagsOf);
  const generator = sources.some((source) => (source as ModifierProbe).isGenerator?.() === true);
  const async = sources.some((source) => (source as ModifierProbe).isAsync?.() === true);
  if (generator) tags.push("generator");
  if (!generator && (async || hasDirectPromiseReturn(signature))) tags.push("returns-promise");
  return [...new Set(tags)];
}

function hasDirectPromiseReturn(signature: SignatureLike | null): boolean {
  const returnType = signature?.getReturnTypeNode()?.getText().trim();
  if (!returnType) return false;
  // Source text is already a parsed TypeNode. Anchoring the whole annotation rejects arrays,
  // unions, and objects that merely contain a nested Promise.
  return /^(?:globalThis\.)?Promise(?:Like)?(?:\s*<[\s\S]*>)?$/.test(returnType);
}

export function telemetryFor(localName: string, qualifiedName: string, enclosingNames: string[]): TelemetryKey {
  return {
    codeNamespace: enclosingNames.length > 0 ? enclosingNames.join(".") : null,
    codeFunction: localName,
    spanNameHints: [...new Set([qualifiedName, localName])],
  };
}
