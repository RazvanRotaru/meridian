/**
 * Admission barrier for the painted scene shown during additive graph inspection.
 *
 * A selection can update synchronously while derive/layout is still working.  That intermediate
 * paint is not a real inspection hop: admitting it would briefly draw provisional cards and, more
 * importantly, record their positions in the append-only ledger.  This pure reducer keeps the last
 * settled scene intact until the candidate is ready, then admits nodes, wires and paint metadata as
 * one frame.
 */

import type { Edge, Node } from "@xyflow/react";
import {
  applyAdditiveNodePositions,
  captureAdditiveNodePositions,
  type AdditiveNodePositionLedger,
} from "./additiveNodePositions";

export interface PaintedScene {
  readonly nodes: Node[];
  readonly edges: Edge[];
  readonly beacons: ReadonlySet<string>;
  readonly highwaySeeds: ReadonlySet<string>;
}

export interface PaintFramePositionSession {
  readonly key: string;
  readonly ledger: AdditiveNodePositionLedger;
}

export interface PaintFrameRetentionState {
  readonly lastSettledScene: PaintedScene | null;
  readonly positionSession: PaintFramePositionSession | null;
}

export interface PaintFrameResolution {
  readonly scene: PaintedScene;
  readonly state: PaintFrameRetentionState;
}

/** Seed the reducer with the scene already visible before an inspection begins. */
export function createPaintFrameRetentionState(
  initialScene: PaintedScene | null,
): PaintFrameRetentionState {
  return {
    lastSettledScene: initialScene,
    positionSession: null,
  };
}

/**
 * Resolve one candidate paint without mutating the preceding state.
 *
 * While an inspection is opening, advancing, or closing, `deferred` keeps the exact last settled
 * frame on screen.  Outside an inspection there is nothing to protect, so an unrelated deferred
 * render remains a normal raw paint.  A ready inspection frame atomically captures additive node
 * positions and its matching edges/beacons/highway seeds; a ready null key closes the session and
 * returns the candidate without positional overrides.
 */
export function resolvePaintFrameRetention(
  candidate: PaintedScene,
  state: PaintFrameRetentionState,
  sessionKey: string | null,
  deferred: boolean,
): PaintFrameResolution {
  if (deferred && (sessionKey !== null || state.positionSession !== null)) {
    return { scene: state.lastSettledScene ?? candidate, state };
  }

  if (sessionKey === null) {
    return {
      scene: candidate,
      state: {
        lastSettledScene: candidate,
        positionSession: null,
      },
    };
  }

  const previousLedger = state.positionSession?.key === sessionKey
    ? state.positionSession.ledger
    : captureAdditiveNodePositions(state.lastSettledScene?.nodes ?? []);
  const ledger = captureAdditiveNodePositions(candidate.nodes, previousLedger, candidate.edges);
  const scene: PaintedScene = {
    ...candidate,
    nodes: applyAdditiveNodePositions(candidate.nodes, ledger),
  };
  return {
    scene,
    state: {
      lastSettledScene: scene,
      positionSession: { key: sessionKey, ledger },
    },
  };
}
