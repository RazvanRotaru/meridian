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
  if (probe.isExported?.()) tags.push("export");
  if (probe.isAsync?.()) tags.push("async");
  if (probe.isStatic?.()) tags.push("static");
  if (probe.isAbstract?.()) tags.push("abstract");
  if (probe.isReadonly?.()) tags.push("readonly");
  const scope = probe.getScope?.();
  if (scope) tags.push(scope);
  return tags;
}

export function telemetryFor(localName: string, qualifiedName: string, enclosingNames: string[]): TelemetryKey {
  return {
    codeNamespace: enclosingNames.length > 0 ? enclosingNames.join(".") : null,
    codeFunction: localName,
    spanNameHints: [...new Set([qualifiedName, localName])],
  };
}
