/**
 * Turns a unit's SOLID metrics into human guidance: a glossary of what each score means, and a
 * per-unit diagnosis (a verdict + plain-language findings + concrete refactor suggestions). Pure —
 * (metrics) in, strings out; no React, no store. Mirrors the smell rules in `composition.ts` so the
 * advice never contradicts the chips a card shows.
 */

import type { Smell, UnitMetrics } from "./composition";

export type Tone = "good" | "warn" | "bad";

/** One row of the "what the scores mean" glossary. */
export interface ScoreGloss {
  key: string;
  name: string;
  blurb: string;
  healthy: string;
}

export const SCORE_GLOSSARY: ScoreGloss[] = [
  { key: "cohesion", name: "Cohesion", blurb: "How well a unit's members form one job (LCOM4). 1 = a single cluster; toward 0 = unrelated groups sharing a file.", healthy: "aim high — near 1" },
  { key: "Ce", name: "Ce — efferent coupling", blurb: "Outgoing dependencies: units this one uses. High Ce means it leans on many others.", healthy: "lower is easier to change" },
  { key: "Ca", name: "Ca — afferent coupling", blurb: "Incoming dependencies: units that rely on this one. High Ca means many things break if it changes.", healthy: "high is fine for stable abstractions" },
  { key: "I", name: "I — instability", blurb: "Ce / (Ca + Ce). 0 = only depended upon (stable); 1 = only depends outward (unstable).", healthy: "should track A (see D)" },
  { key: "A", name: "A — abstractness", blurb: "Share of abstract members (an interface = 1). 0 = fully concrete; 1 = fully abstract.", healthy: "should track I (see D)" },
  { key: "D", name: "D — distance", blurb: "|A + I - 1|: distance from the 'main sequence'. 0 = balanced; high = zone of pain (stable+concrete) or uselessness (abstract+unstable).", healthy: "<= 0.2 green · >= 0.7 red" },
];

/** A unit's verdict + why + what to do. */
export interface UnitDiagnosis {
  headline: string;
  tone: Tone;
  findings: string[];
  suggestions: string[];
}

// Worst-first when several smells apply — mirrors the worklist's severity ranking.
const SMELL_ORDER: Smell[] = ["god-module", "low-cohesion", "zone-of-pain", "zone-of-uselessness"];
const SMELL_TONE: Record<Smell, Tone> = {
  "god-module": "bad",
  "zone-of-pain": "bad",
  "low-cohesion": "warn",
  "zone-of-uselessness": "warn",
};
const SMELL_HEADLINE: Record<Smell, string> = {
  "god-module": "Hub — coupled both ways",
  "zone-of-pain": "Zone of pain — hard to change",
  "low-cohesion": "Low cohesion — doing several jobs",
  "zone-of-uselessness": "Zone of uselessness — unused abstraction",
};

// The reading of the scores behind each smell, and the action it calls for. Records (keyed by Smell)
// so the union stays exhaustive without a fallthrough return.
const FINDING: Record<Smell, (m: UnitMetrics) => string> = {
  "god-module": (m) => `Heavily coupled both ways — ${m.ca} in (Ca), ${m.ce} out (Ce). Changes here ripple widely.`,
  "zone-of-pain": (m) => `Concrete (A ${m.abstractness}) yet stable (I ${m.instability}) and depended on by ${m.ca} (Ca) — costly to change.`,
  "zone-of-uselessness": (m) => `Abstract (A ${m.abstractness}) but barely used (I ${m.instability}, Ca ${m.ca}) — an abstraction without callers.`,
  "low-cohesion": (m) => `${m.members} members split into ${m.lcomComponents} unrelated clusters (cohesion ${m.cohesion}).`,
};
const SUGGESTION: Record<Smell, (m: UnitMetrics) => string> = {
  "god-module": () => "Extract cohesive sub-units and depend on narrow interfaces to cut the fan-in / fan-out.",
  "zone-of-pain": () => "Introduce an interface for its stable contract so dependents rely on the abstraction, not the implementation.",
  "zone-of-uselessness": () => "Remove or inline the unused abstraction, or wire up its intended callers.",
  "low-cohesion": (m) => `Split into ${m.lcomComponents} units along the clusters — one responsibility each (SRP).`,
};

/** Diagnose a unit from its metrics: verdict tone + findings + suggestions, worst smell first. */
export function diagnoseUnit(m: UnitMetrics): UnitDiagnosis {
  const smells = SMELL_ORDER.filter((smell) => m.smells.includes(smell));
  if (smells.length === 0) {
    return healthyDiagnosis(m);
  }
  return {
    headline: SMELL_HEADLINE[smells[0]],
    tone: smells.some((smell) => SMELL_TONE[smell] === "bad") ? "bad" : "warn",
    findings: smells.map((smell) => FINDING[smell](m)),
    suggestions: smells.map((smell) => SUGGESTION[smell](m)),
  };
}

// A clean unit: acknowledge the balance, and whether it sits on the sequence or just off it.
function healthyDiagnosis(m: UnitMetrics): UnitDiagnosis {
  const onSequence = m.distance <= 0.2;
  return {
    headline: onSequence ? "Healthy — on the main sequence" : "No smells — slightly off the main sequence",
    tone: onSequence ? "good" : "warn",
    findings: [
      onSequence
        ? `Balanced abstractness and instability (D ${m.distance}).`
        : `A bit off balance (D ${m.distance}), but under every smell threshold.`,
      `Cohesion ${m.cohesion} across ${m.members} member${m.members === 1 ? "" : "s"}.`,
    ],
    suggestions: onSequence ? ["No action needed — keep it this way."] : ["Watch it; no refactor needed yet."],
  };
}
