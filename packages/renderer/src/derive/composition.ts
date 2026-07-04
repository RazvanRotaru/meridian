/**
 * Robert C. Martin's component-design metrics, per composition unit, from the graph's nodes +
 * edges: coupling (Ca/Ce), instability, abstractness, distance from the main sequence, LCOM4
 * cohesion, and the design smells they surface. Pure — no React, no DOM.
 *
 * A "unit" is a class/interface/object body or a whole module; its members are the callables it
 * owns (see composition-graph). All thresholds are named consts so they stay tunable.
 */

import type { GraphEdge, GraphNode } from "@meridian/core";
import {
  accumulateCoupling,
  buildUnitIndex,
  countComponents,
  emptyCoupling,
  groupMembersByUnit,
  type UnitCoupling,
} from "./composition-graph";

export type Smell = "god-module" | "zone-of-pain" | "zone-of-uselessness" | "low-cohesion";

export interface UnitMetrics {
  id: string;
  kind: string;
  displayName: string;
  moduleFile: string;
  members: number;
  cohesion: number;
  lcomComponents: number;
  ce: number;
  ca: number;
  instability: number;
  abstractness: number;
  distance: number;
  externalFanout: number;
  smells: Smell[];
}

// Smell thresholds — pinned but tunable.
const GOD_MODULE_COUPLING = 5; // Ca AND Ce both ≥ this → a hub coupled both ways.
const PAIN_MAX_ABSTRACTNESS = 0.3;
const PAIN_MAX_INSTABILITY = 0.3;
const PAIN_MIN_AFFERENT = 3; // concrete AND actually depended upon → costly to change.
const USELESS_MIN_ABSTRACTNESS = 0.7;
const USELESS_MIN_INSTABILITY = 0.7;
const LOW_COHESION_MIN_MEMBERS = 4;
const LOW_COHESION_MAX_COHESION = 0.34; // flags fragmentation relative to size (low cohesion), not a raw component count.

/** Compute metrics for every unit in the graph, keyed by unit id. */
export function computeCompositionMetrics(nodes: GraphNode[], edges: GraphEdge[]): Map<string, UnitMetrics> {
  const index = buildUnitIndex(nodes);
  const membersByUnit = groupMembersByUnit(nodes, index);
  const couplingByUnit = accumulateCoupling(edges, index);
  const metrics = new Map<string, UnitMetrics>();
  for (const unit of index.units) {
    const members = membersByUnit.get(unit.id) ?? [];
    const coupling = couplingByUnit.get(unit.id) ?? emptyCoupling();
    metrics.set(unit.id, metricsFor(unit, members, coupling));
  }
  return metrics;
}

function metricsFor(unit: GraphNode, members: GraphNode[], coupling: UnitCoupling): UnitMetrics {
  const ce = coupling.efferent.size;
  const ca = coupling.afferent.size;
  const instability = instabilityOf(ca, ce);
  const abstractness = abstractnessOf(unit, members);
  const lcomComponents = countComponents(members.map((member) => member.id), coupling.internalCalls);
  const cohesion = cohesionOf(members.length, lcomComponents);
  const facts = { ca, ce, instability, abstractness, memberCount: members.length, cohesion };
  return {
    id: unit.id,
    kind: unit.kind,
    displayName: unit.displayName,
    moduleFile: unit.location.file,
    members: members.length,
    cohesion: round2(cohesion),
    lcomComponents,
    ce,
    ca,
    instability: round2(instability),
    abstractness: round2(abstractness),
    distance: round2(Math.abs(abstractness + instability - 1)),
    externalFanout: coupling.external.size,
    smells: smellsFor(facts),
  };
}

function instabilityOf(ca: number, ce: number): number {
  const total = ca + ce;
  return total === 0 ? 0 : ce / total;
}

/** Interfaces are fully abstract by definition; else the share of members tagged "abstract". */
function abstractnessOf(unit: GraphNode, members: GraphNode[]): number {
  if (unit.kind === "interface") {
    return 1;
  }
  if (members.length === 0) {
    return 0;
  }
  return members.filter(isAbstract).length / members.length;
}

function isAbstract(node: GraphNode): boolean {
  return node.tags?.includes("abstract") ?? false;
}

/** 1 when the members form a single call cluster; →0 as they fragment into unrelated jobs. */
function cohesionOf(memberCount: number, lcomComponents: number): number {
  if (memberCount <= 1) {
    return 1;
  }
  return 1 - (lcomComponents - 1) / (memberCount - 1);
}

interface SmellFacts {
  ca: number;
  ce: number;
  instability: number;
  abstractness: number;
  memberCount: number;
  cohesion: number;
}

function smellsFor(facts: SmellFacts): Smell[] {
  const smells: Smell[] = [];
  if (facts.ca >= GOD_MODULE_COUPLING && facts.ce >= GOD_MODULE_COUPLING) {
    smells.push("god-module");
  }
  if (facts.abstractness <= PAIN_MAX_ABSTRACTNESS && facts.instability <= PAIN_MAX_INSTABILITY && facts.ca >= PAIN_MIN_AFFERENT) {
    smells.push("zone-of-pain");
  }
  if (facts.abstractness >= USELESS_MIN_ABSTRACTNESS && facts.instability >= USELESS_MIN_INSTABILITY) {
    smells.push("zone-of-uselessness");
  }
  if (facts.memberCount >= LOW_COHESION_MIN_MEMBERS && facts.cohesion <= LOW_COHESION_MAX_COHESION) {
    smells.push("low-cohesion");
  }
  return smells;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

// A smell's contribution to a unit's severity — heaviest structural problems weigh most.
const SMELL_WEIGHT: Record<Smell, number> = {
  "god-module": 4,
  "low-cohesion": 3,
  "zone-of-pain": 3,
  "zone-of-uselessness": 2,
};

/** Worst-first for the refactor-candidates panel: heaviest smells, then distance, then size. */
export function rankRefactorCandidates(metrics: Map<string, UnitMetrics> | UnitMetrics[]): UnitMetrics[] {
  const units = Array.isArray(metrics) ? [...metrics] : [...metrics.values()];
  return units.sort(bySeverityDescending);
}

function bySeverityDescending(a: UnitMetrics, b: UnitMetrics): number {
  return (
    severityScore(b) - severityScore(a) ||
    b.distance - a.distance ||
    b.members - a.members ||
    a.id.localeCompare(b.id)
  );
}

function severityScore(unit: UnitMetrics): number {
  return unit.smells.reduce((sum, smell) => sum + SMELL_WEIGHT[smell], 0);
}
