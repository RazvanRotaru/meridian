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
  couplingEdges,
  emptyCoupling,
  groupMembersByUnit,
  type UnitCoupling,
} from "./composition-graph";
import { cyclePeersByUnit } from "./composition-cycles";

export type Smell = "god-module" | "zone-of-pain" | "zone-of-uselessness" | "low-cohesion" | "dependency-cycle";

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
  /** The other units of this unit's dependency cycle (its SCC), sorted; empty when acyclic. */
  cyclePeers: string[];
  /** Stable Dependencies Principle violations: efferent targets MORE unstable than this unit. */
  sdpViolations: number;
  smells: Smell[];
}

// Smell thresholds — pinned but tunable.
const GOD_MODULE_COUPLING = 5; // Ca AND Ce both ≥ this → a hub coupled both ways.
const PAIN_MAX_ABSTRACTNESS = 0.3;
const PAIN_MAX_INSTABILITY = 0.3;
const PAIN_MIN_AFFERENT = 3; // concrete AND actually depended upon → costly to change.
const USELESS_MIN_ABSTRACTNESS = 0.7;
const USELESS_MIN_INSTABILITY = 0.7;
const LOW_COHESION_MIN_MEMBERS = 8; // gate on the cohesion member set, not the full callable count.
const LOW_COHESION_MIN_COMPONENTS = 3; // ≥3 unrelated jobs → SRP split candidate.

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
  markDependencyCycles(metrics, nodes, edges);
  countSdpViolations(metrics, couplingByUnit);
  return metrics;
}

/** Post-pass: every unit inside a ≥2-unit strongly-connected component of the coupling graph is
 * in a dependency cycle — flag it and record its peers so the UI/tests can name the loop. */
function markDependencyCycles(metrics: Map<string, UnitMetrics>, nodes: GraphNode[], edges: GraphEdge[]): void {
  for (const [unitId, peers] of cyclePeersByUnit(couplingEdges(nodes, edges))) {
    const metric = metrics.get(unitId);
    if (metric) {
      metric.cyclePeers = peers;
      metric.smells.unshift("dependency-cycle"); // worst smell first, so the chip row leads with it.
    }
  }
}

/** Post-pass (needs every unit's instability): SDP says "depend toward stability", so each
 * efferent target strictly MORE unstable than the unit itself is one violation. Compares RAW
 * instability (recomputed from the integer Ce/Ca), never the rounded display field — otherwise a
 * strict `>` collapses to equality at a 2-decimal boundary and silently drops a real violation. */
function countSdpViolations(metrics: Map<string, UnitMetrics>, couplingByUnit: Map<string, UnitCoupling>): void {
  const rawInstability = (m: UnitMetrics | undefined) => (m ? instabilityOf(m.ca, m.ce) : 0);
  for (const metric of metrics.values()) {
    const efferent = couplingByUnit.get(metric.id)?.efferent ?? new Set<string>();
    const own = rawInstability(metric);
    metric.sdpViolations = [...efferent].filter((target) => rawInstability(metrics.get(target)) > own).length;
  }
}

function metricsFor(unit: GraphNode, members: GraphNode[], coupling: UnitCoupling): UnitMetrics {
  const ce = coupling.efferent.size;
  const ca = coupling.afferent.size;
  const instability = instabilityOf(ca, ce);
  const abstractness = abstractnessOf(unit, members);
  const cohesionMembers = members.filter(isCohesionMember);
  const lcomComponents = countComponents(cohesionMembers.map((member) => member.id), coupling.internalCalls);
  const cohesion = cohesionOf(cohesionMembers.length, lcomComponents);
  const facts = { ca, ce, instability, abstractness, cohesionMemberCount: cohesionMembers.length, lcomComponents };
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
    cyclePeers: [],
    sdpViolations: 0,
    smells: smellsFor(facts),
  };
}

// The cohesion story: constructors and accessors are wiring, not behaviour — a constructor touches
// every collaborator and a getter touches one field, so both blur the LCOM call-cluster signal.
// They are excluded from the ENTIRE cohesion computation (component count, the cohesion score's
// denominator, and the SPLIT member gate) so those three displayed numbers always agree; `members`
// keeps the full callable count because it measures unit SIZE and feeds abstractness, not cohesion.
// Detection stays conservative — only what extractors clearly emit: the TS extractor names
// constructors "constructor" (Python: "__init__"); accessor-ness only ever arrives as a tag
// (Python tags @property "property"; TS emits no accessor marker today, so its get/set pass through).
const CONSTRUCTOR_NAMES: ReadonlySet<string> = new Set(["constructor", "__init__"]);
const ACCESSOR_TAGS: ReadonlySet<string> = new Set(["get", "set", "accessor", "property"]);

function isCohesionMember(node: GraphNode): boolean {
  if (CONSTRUCTOR_NAMES.has(node.displayName)) {
    return false;
  }
  return !(node.tags ?? []).some((tag) => ACCESSOR_TAGS.has(tag));
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
  cohesionMemberCount: number;
  lcomComponents: number;
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
  if (facts.cohesionMemberCount >= LOW_COHESION_MIN_MEMBERS && facts.lcomComponents >= LOW_COHESION_MIN_COMPONENTS) {
    smells.push("low-cohesion");
  }
  return smells;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

// A smell's contribution to a unit's severity — heaviest structural problems weigh most. A
// dependency cycle outranks even a god-module: it can't be refactored one unit at a time.
const SMELL_WEIGHT: Record<Smell, number> = {
  "dependency-cycle": 5,
  "god-module": 4,
  "low-cohesion": 3,
  "zone-of-pain": 3,
  "zone-of-uselessness": 2,
};

/** Worst-first for the refactor-candidates panel: heaviest smells (churn-amplified when a git
 * churn map is supplied — a smelly unit that also changes often outranks a quiet one), then
 * distance, then size. Without churn the ranking is the unweighted severity order. */
export function rankRefactorCandidates(
  metrics: Map<string, UnitMetrics> | UnitMetrics[],
  churnByUnitId?: Map<string, number>,
): UnitMetrics[] {
  const units = Array.isArray(metrics) ? [...metrics] : [...metrics.values()];
  return units.sort((a, b) => bySeverityDescending(a, b, churnByUnitId));
}

function bySeverityDescending(a: UnitMetrics, b: UnitMetrics, churnByUnitId?: Map<string, number>): number {
  return (
    severityScore(b, churnByUnitId) - severityScore(a, churnByUnitId) ||
    b.distance - a.distance ||
    b.members - a.members ||
    a.id.localeCompare(b.id)
  );
}

function severityScore(unit: UnitMetrics, churnByUnitId?: Map<string, number>): number {
  const smellWeight = unit.smells.reduce((sum, smell) => sum + SMELL_WEIGHT[smell], 0);
  return smellWeight * churnMultiplier(churnByUnitId?.get(unit.id));
}

// Frequently-changed code hurts more when it's smelly: churn scales severity up to 3× (capped at
// 20 commits so one hot file can't drown the ranking); no churn data leaves severity untouched.
const CHURN_CAP = 20;

function churnMultiplier(churn: number | undefined): number {
  return churn === undefined ? 1 : 1 + Math.min(churn, CHURN_CAP) / 10;
}
