/**
 * Derive interface-method implementation relationships after inheritance resolution.
 *
 * Per-package extraction cannot connect a sibling package's interface while that package's
 * ts-morph project is absent. The workspace join does resolve the ordinary class-level
 * `implements` and `extends` edges, so this pass consumes those resolved plain-data edges and
 * the structural node/member summaries. Single-project extraction uses the same path.
 */

import type { CallSite, GraphNode } from "@meridian/core";
import type { Node } from "ts-morph";
import type { RawEdge } from "./edge-pass";
import { callSiteOf, type NodeDescriptor } from "./model";

interface CallableShape {
  minArgs: number;
  /** `null` means an unbounded rest parameter. */
  maxArgs: number | null;
}

/** Plain data retained after a bounded package's ts-morph project is released. */
export interface ImplementationMember {
  id: string;
  parentId: string;
  name: string;
  hasBody: boolean;
  isStatic: boolean;
  shape: CallableShape | null;
  callSite: CallSite;
}

export function implementationMembers(descriptors: readonly NodeDescriptor[]): ImplementationMember[] {
  const members: ImplementationMember[] = [];
  for (const descriptor of descriptors) {
    if (descriptor.kind !== "method" || descriptor.parent === null || descriptor.declarationNode === null) {
      continue;
    }
    members.push({
      id: descriptor.finalId,
      parentId: descriptor.parent.finalId,
      name: descriptor.displayName,
      hasBody: descriptor.callableNode !== null,
      isStatic: descriptor.tags.includes("static"),
      shape: callableShape(descriptor.declarationNode, descriptor.callableNode),
      callSite: callSiteOf(descriptor.declarationNode, descriptor.location.file),
    });
  }
  return members;
}

/**
 * One `implementedBy` edge per contract-method declaration. Targets are always concrete,
 * instance, body-bearing methods. A superclass body is selected when the implementing class
 * inherits rather than overrides the method; overload declarations and static lookalikes never
 * become targets.
 */
export function deriveImplementedByEdges(
  inheritanceEdges: readonly RawEdge[],
  nodes: readonly GraphNode[],
  members: readonly ImplementationMember[],
): RawEdge[] {
  const nodeKind = new Map(nodes.map((node) => [node.id, node.kind]));
  const membersByParent = groupMembersByParent(members);
  const classBase = new Map<string, string>();
  const interfaceBases = new Map<string, string[]>();

  for (const edge of inheritanceEdges) {
    const target = resolvedTargetId(edge);
    if (edge.kind !== "extends" || target === null) continue;
    if (nodeKind.get(edge.source) === "class" && nodeKind.get(target) === "class") {
      classBase.set(edge.source, target);
    } else if (nodeKind.get(edge.source) === "interface" && nodeKind.get(target) === "interface") {
      const bases = interfaceBases.get(edge.source) ?? [];
      bases.push(target);
      interfaceBases.set(edge.source, bases);
    }
  }

  const derived: RawEdge[] = [];
  const seenPairs = new Set<string>();
  for (const edge of inheritanceEdges) {
    const contractId = resolvedTargetId(edge);
    if (
      edge.kind !== "implements" ||
      contractId === null ||
      nodeKind.get(edge.source) !== "class" ||
      nodeKind.get(contractId) !== "interface"
    ) {
      continue;
    }
    for (const contract of contractMethods(contractId, membersByParent, interfaceBases)) {
      const implementation = findImplementation(edge.source, contract, membersByParent, classBase);
      if (implementation === null) continue;
      const pair = `${contract.id}\u0000${implementation.id}`;
      if (seenPairs.has(pair)) continue;
      seenPairs.add(pair);
      derived.push({
        source: contract.id,
        kind: "implementedBy",
        resolution: resolved(implementation.id),
        callSite: implementation.callSite,
      });
    }
  }
  return derived;
}

function groupMembersByParent(
  members: readonly ImplementationMember[],
): ReadonlyMap<string, readonly ImplementationMember[]> {
  const grouped = new Map<string, ImplementationMember[]>();
  for (const member of members) {
    const siblings = grouped.get(member.parentId) ?? [];
    siblings.push(member);
    grouped.set(member.parentId, siblings);
  }
  return grouped;
}

function contractMethods(
  interfaceId: string,
  membersByParent: ReadonlyMap<string, readonly ImplementationMember[]>,
  interfaceBases: ReadonlyMap<string, readonly string[]>,
  seenInterfaces = new Set<string>(),
  seenMethods = new Set<string>(),
): ImplementationMember[] {
  if (seenInterfaces.has(interfaceId)) return [];
  seenInterfaces.add(interfaceId);
  const methods: ImplementationMember[] = [];
  for (const method of membersByParent.get(interfaceId) ?? []) {
    if (!seenMethods.has(method.id)) {
      seenMethods.add(method.id);
      methods.push(method);
    }
  }
  for (const base of interfaceBases.get(interfaceId) ?? []) {
    methods.push(...contractMethods(base, membersByParent, interfaceBases, seenInterfaces, seenMethods));
  }
  return methods;
}

function findImplementation(
  classId: string,
  contract: ImplementationMember,
  membersByParent: ReadonlyMap<string, readonly ImplementationMember[]>,
  classBase: ReadonlyMap<string, string>,
): ImplementationMember | null {
  const seen = new Set<string>();
  let current: string | undefined = classId;
  while (current !== undefined && !seen.has(current)) {
    seen.add(current);
    // Static members do not shadow or fulfill an inherited instance contract.
    const declared = (membersByParent.get(current) ?? []).filter(
      (member) => member.name === contract.name && !member.isStatic,
    );
    if (declared.length > 0) {
      const candidates = declared
        .filter((member) => member.hasBody && callableCovers(member.shape, contract.shape))
        .sort((left, right) => candidateRank(left, contract) - candidateRank(right, contract) || left.id.localeCompare(right.id));
      // A declared instance member shadows the base even when it is abstract/incompatible.
      return candidates[0] ?? null;
    }
    current = classBase.get(current);
  }
  return null;
}

/** The implementation must accept every argument count admitted by the contract. */
function callableCovers(implementation: CallableShape | null, contract: CallableShape | null): boolean {
  if (implementation === null || contract === null) return true;
  if (implementation.minArgs > contract.minArgs) return false;
  if (contract.maxArgs === null) return implementation.maxArgs === null;
  return implementation.maxArgs === null || implementation.maxArgs >= contract.maxArgs;
}

function candidateRank(candidate: ImplementationMember, contract: ImplementationMember): number {
  if (candidate.shape === null || contract.shape === null) return 1;
  return candidate.shape.minArgs === contract.shape.minArgs && candidate.shape.maxArgs === contract.shape.maxArgs ? 0 : 1;
}

interface ParameterProbe {
  isOptional(): boolean;
  isRestParameter(): boolean;
  getInitializer(): Node | undefined;
}

function callableShape(declaration: Node, callable: Node | null): CallableShape | null {
  const owner = parameterOwner(declaration) ?? (callable === null ? null : parameterOwner(callable));
  if (owner === null) return null;
  const parameters = owner.getParameters();
  let minArgs = 0;
  let hasRest = false;
  for (const parameter of parameters) {
    if (!parameter.isOptional() && !parameter.isRestParameter() && parameter.getInitializer() === undefined) {
      minArgs += 1;
    }
    hasRest ||= parameter.isRestParameter();
  }
  return { minArgs, maxArgs: hasRest ? null : parameters.length };
}

function parameterOwner(node: Node): { getParameters(): ParameterProbe[] } | null {
  const probe = node as unknown as { getParameters?(): ParameterProbe[] };
  return typeof probe.getParameters === "function" ? { getParameters: () => probe.getParameters!() } : null;
}

function resolvedTargetId(edge: RawEdge): string | null {
  return edge.resolution.resolution === "resolved" ? edge.resolution.resolvedTarget : null;
}

function resolved(target: string): RawEdge["resolution"] {
  return {
    resolution: "resolved",
    resolvedTarget: target,
    externalModulePath: null,
    externalQualname: null,
    threw: false,
  };
}
