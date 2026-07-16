/**
 * Optional artifact-authored causal sequence models.
 *
 * `logicFlow` is intentionally intraprocedural. Some lifecycle stories cross callbacks, RPC
 * boundaries, and a shared promise barrier, so an analysis may attach the already-composed
 * sequence under this extension instead of pretending those events are nested source calls.
 */

import type { GraphArtifact, NodeId } from "@meridian/core";
import type {
  SequenceFrame,
  SequenceParticipant,
  SequenceRow,
  SequenceTimelineModel,
} from "./sequenceTimelineModel";

export const SEQUENCE_TIMELINE_EXTENSION = "sequenceTimeline";

/** Read one bounded model defensively: graph extensions are untyped JSON supplied by the artifact. */
export function sequenceTimelineFor(
  artifact: GraphArtifact,
  rootId: NodeId,
): SequenceTimelineModel | null {
  const extension = artifact.extensions?.[SEQUENCE_TIMELINE_EXTENSION];
  if (!isRecord(extension)) return null;
  const candidate = extension[rootId];
  if (!isRecord(candidate)) return null;

  const participants = arrayOf(candidate.participants, isParticipant);
  const rows = arrayOf(candidate.rows, isRow);
  const frames = arrayOf(candidate.frames, isFrame);
  if (participants === null || rows === null || frames === null) return null;

  const participantIds = new Set(participants.map((participant) => participant.id));
  if (participantIds.size !== participants.length) return null;
  if (!rows.every((row) => row.type === "message"
    ? participantIds.has(row.from) && participantIds.has(row.to)
    : participantIds.has(row.participant))) return null;

  return {
    participants,
    rows,
    frames,
    truncated: candidate.truncated === true,
    guards: {
      maxInlineDepth: positiveInt(candidate.guards, "maxInlineDepth", 1),
      maxParticipants: positiveInt(candidate.guards, "maxParticipants", Math.max(2, participants.length)),
      maxRows: positiveInt(candidate.guards, "maxRows", Math.max(2, rows.length + 1)),
    },
  };
}

function isParticipant(value: unknown): value is SequenceParticipant {
  if (!isRecord(value)) return false;
  return typeof value.id === "string"
    && typeof value.label === "string"
    && typeof value.kind === "string"
    && (value.detail === null || typeof value.detail === "string")
    && (value.nodeId === null || typeof value.nodeId === "string");
}

function isRow(value: unknown): value is SequenceRow {
  if (!isRecord(value)
    || typeof value.id !== "string"
    || !Number.isInteger(value.row)
    || (value.visualRole !== "primary" && value.visualRole !== "detail")) return false;
  if (value.type === "message") {
    return (value.kind === "call" || value.kind === "return")
      && typeof value.tone === "string"
      && typeof value.from === "string"
      && typeof value.to === "string"
      && typeof value.label === "string"
      && (value.target === null || typeof value.target === "string")
      && typeof value.drillable === "boolean";
  }
  return value.type === "note"
    && typeof value.participant === "string"
    && typeof value.tone === "string"
    && typeof value.label === "string";
}

function isFrame(value: unknown): value is SequenceFrame {
  return isRecord(value)
    && typeof value.id === "string"
    && (value.kind === "loop" || value.kind === "callback" || value.kind === "alt")
    && typeof value.label === "string"
    && Number.isInteger(value.startRow)
    && Number.isInteger(value.endRow)
    && Array.isArray(value.separators)
    && value.separators.every((separator) => isRecord(separator)
      && Number.isInteger(separator.row)
      && typeof separator.label === "string");
}

function arrayOf<T>(value: unknown, predicate: (entry: unknown) => entry is T): T[] | null {
  return Array.isArray(value) && value.every(predicate) ? value : null;
}

function positiveInt(value: unknown, key: string, fallback: number): number {
  if (!isRecord(value)) return fallback;
  const candidate = value[key];
  return Number.isInteger(candidate) && Number(candidate) > 0 ? Number(candidate) : fallback;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
