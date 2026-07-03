/**
 * Builders that turn ts-morph declarations into staging `NodeDescriptor`s. Id construction
 * goes through core's `buildNodeId`/normalizers so the node-id grammar lives in exactly one
 * place; ordinals are appended later, once sibling collisions are known.
 */

import type { Node } from "ts-morph";
import { buildNodeId, collapseLocals, normalizeScopeSeparators } from "@meridian/core";
import type { NodeKind } from "@meridian/core";
import { lineColOf, type NodeDescriptor } from "./model";
import { modifierTagsOf, signatureOf, summaryOf, telemetryFor, type SignatureLike } from "./node-fields";
import { posixBasename } from "./paths";

export interface IdContext {
  lang: string;
  modulePath: string;
  relPath: string;
}

export interface MemberSpec {
  kind: NodeKind;
  localName: string;
  enclosingNames: string[];
  parent: NodeDescriptor;
  declarationNode: Node;
  callableNode: Node | null;
  signatureSource: SignatureLike | null;
  emitTelemetry: boolean;
}

export function packageDescriptor(lang: string, packagePath: string, parent: NodeDescriptor | null): NodeDescriptor {
  return {
    kind: "package",
    idParts: { lang, modulePath: packagePath },
    displayName: posixBasename(packagePath),
    qualifiedName: packagePath,
    summary: null,
    signature: null,
    tags: [],
    telemetry: null,
    location: { file: packagePath, startLine: 1, endLine: 1 },
    startCol: 1,
    parent,
    declarationNode: null,
    callableNode: null,
    finalId: "",
  };
}

export function moduleDescriptor(context: IdContext, sourceFile: Node, parent: NodeDescriptor | null): NodeDescriptor {
  return {
    kind: "module",
    idParts: { lang: context.lang, modulePath: context.modulePath },
    displayName: posixBasename(context.relPath),
    qualifiedName: context.relPath,
    summary: null,
    signature: null,
    tags: [],
    telemetry: null,
    location: { file: context.relPath, startLine: 1, endLine: sourceFile.getEndLineNumber() },
    startCol: 1,
    parent,
    declarationNode: null,
    callableNode: null,
    finalId: "",
  };
}

export function memberDescriptor(context: IdContext, spec: MemberSpec): NodeDescriptor {
  const qualifiedName = qualnameFor(spec.enclosingNames, spec.localName);
  return {
    kind: spec.kind,
    idParts: { lang: context.lang, modulePath: context.modulePath, qualname: qualifiedName },
    displayName: spec.localName,
    qualifiedName,
    summary: summaryOf(spec.declarationNode),
    signature: signatureOf(spec.localName, spec.signatureSource),
    tags: modifierTagsOf(spec.declarationNode),
    telemetry: spec.emitTelemetry ? telemetryFor(spec.localName, qualifiedName, spec.enclosingNames) : null,
    location: locationOf(spec.declarationNode, context.relPath),
    startCol: lineColOf(spec.declarationNode).column,
    parent: spec.parent,
    declarationNode: spec.declarationNode,
    callableNode: spec.callableNode,
    finalId: "",
  };
}

function qualnameFor(enclosingNames: string[], localName: string): string {
  return normalizeScopeSeparators(collapseLocals([...enclosingNames, localName].join(".")));
}

function locationOf(node: Node, relPath: string) {
  return { file: relPath, startLine: node.getStartLineNumber(), endLine: node.getEndLineNumber() };
}

/** The base node id without an ordinal — the key sibling-collision grouping is done on. */
export function baseIdOf(descriptor: NodeDescriptor): string {
  return buildNodeId(descriptor.idParts);
}
