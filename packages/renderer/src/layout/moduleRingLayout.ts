/**
 * Concentric-ring layout for the Module-map lens: pure trig + grid, NO ELK. The entry frame sits at
 * the origin; every other frame is placed by BFS ring on a circle whose radius grows with the ring
 * and is widened when a ring's frames would not otherwise fit around its circumference. Deterministic
 * by construction — no Math.random, no Date — so the same spec always lays out to the same bytes.
 */

import type { Edge, Node } from "@xyflow/react";
import type { ModuleCardData, ModuleFrameData, ModuleMapSpec } from "../derive/moduleMap";

const CARD_WIDTH = 180;
const CARD_HEIGHT = 52;
const CARD_GAP = 14;
const TITLE_BAR = 34;
const FRAME_PADDING = 16;
const RING_BASE = 260;
const RING_STEP = 260;
const FRAME_GAP = 64;
const START_ANGLE = -Math.PI / 2;

type FrameNode = Node<ModuleFrameData, "frame">;
type FileNode = Node<ModuleCardData, "file">;

interface PackedFrame {
  spec: ModuleMapSpec["frames"][number];
  width: number;
  height: number;
  cards: Array<{ id: string; data: ModuleCardData; x: number; y: number }>;
}

export function layoutModuleMap(spec: ModuleMapSpec): { nodes: Node[]; edges: Edge[] } {
  if (spec.files.length === 0) {
    return { nodes: [], edges: [] };
  }
  const packed = spec.frames.map((frame) => packFrame(frame, spec.files));
  const positions = placeFrames(packed);
  return { nodes: emitNodes(packed, positions), edges: spec.edges.map(toEdge) };
}

/** Grid-pack a frame's cards into a title-barred box, returning card offsets and the box size. */
function packFrame(frame: ModuleMapSpec["frames"][number], files: ModuleMapSpec["files"]): PackedFrame {
  const members = files.filter((file) => file.frameId === frame.id);
  const columns = Math.max(1, Math.ceil(Math.sqrt(members.length)));
  const rows = Math.max(1, Math.ceil(members.length / columns));
  const cards = members.map((file, index) => placeCard(file, index, columns));
  return { spec: frame, width: frameWidth(columns), height: frameHeight(rows), cards };
}

function placeCard(file: ModuleMapSpec["files"][number], index: number, columns: number) {
  const column = index % columns;
  const row = Math.floor(index / columns);
  return {
    id: file.id,
    data: file.data,
    x: FRAME_PADDING + column * (CARD_WIDTH + CARD_GAP),
    y: TITLE_BAR + FRAME_PADDING + row * (CARD_HEIGHT + CARD_GAP),
  };
}

function frameWidth(columns: number): number {
  return FRAME_PADDING * 2 + columns * CARD_WIDTH + (columns - 1) * CARD_GAP;
}

function frameHeight(rows: number): number {
  return TITLE_BAR + FRAME_PADDING * 2 + rows * CARD_HEIGHT + (rows - 1) * CARD_GAP;
}

/** Absolute top-left of every frame, grouped by ring and placed on its concentric circle. */
function placeFrames(packed: PackedFrame[]): Map<string, { x: number; y: number }> {
  const positions = new Map<string, { x: number; y: number }>();
  for (const [ring, frames] of framesByRing(packed)) {
    placeRing(ring, frames, positions);
  }
  return positions;
}

function placeRing(ring: number, frames: PackedFrame[], positions: Map<string, { x: number; y: number }>): void {
  if (ring === 0 && frames.length === 1) {
    positions.set(frames[0].spec.id, topLeft(0, 0, frames[0]));
    return;
  }
  const radius = ringRadius(ring, frames);
  frames.forEach((frame, index) => {
    const angle = START_ANGLE + (2 * Math.PI * index) / frames.length;
    positions.set(frame.spec.id, topLeft(radius * Math.cos(angle), radius * Math.sin(angle), frame));
  });
}

/** The ring radius: the stepped nominal, widened so the ring's frames fit around its circumference. */
function ringRadius(ring: number, frames: PackedFrame[]): number {
  return Math.max(RING_BASE + ring * RING_STEP, circumferenceRadius(frames));
}

function circumferenceRadius(frames: PackedFrame[]): number {
  const needed = frames.reduce((sum, frame) => sum + diagonal(frame) + FRAME_GAP, 0);
  return needed / (2 * Math.PI);
}

function diagonal(frame: PackedFrame): number {
  return Math.hypot(frame.width, frame.height);
}

/** Centre the frame on a point: React Flow positions are top-left, so back off half its size. */
function topLeft(centerX: number, centerY: number, frame: PackedFrame): { x: number; y: number } {
  return { x: centerX - frame.width / 2, y: centerY - frame.height / 2 };
}

function framesByRing(packed: PackedFrame[]): Map<number, PackedFrame[]> {
  const byRing = new Map<number, PackedFrame[]>();
  for (const frame of packed) {
    const ring = byRing.get(frame.spec.ring);
    if (ring) {
      ring.push(frame);
    } else {
      byRing.set(frame.spec.ring, [frame]);
    }
  }
  return byRing;
}

/** Frames first, then their cards — React Flow requires a parent node ahead of its children. */
function emitNodes(packed: PackedFrame[], positions: Map<string, { x: number; y: number }>): Node[] {
  const frames = packed.map((frame) => frameNode(frame, positions.get(frame.spec.id) as { x: number; y: number }));
  const cards = packed.flatMap((frame) => frame.cards.map((card) => cardNode(card, frame.spec.id)));
  return [...frames, ...cards];
}

function frameNode(frame: PackedFrame, position: { x: number; y: number }): FrameNode {
  return {
    id: frame.spec.id,
    type: "frame",
    position,
    style: { width: frame.width, height: frame.height },
    data: frame.spec.data,
  };
}

function cardNode(card: PackedFrame["cards"][number], frameId: string): FileNode {
  return {
    id: card.id,
    type: "file",
    position: { x: card.x, y: card.y },
    parentId: frameId,
    extent: "parent",
    style: { width: CARD_WIDTH, height: CARD_HEIGHT },
    data: card.data,
  };
}

function toEdge(edge: ModuleMapSpec["edges"][number]): Edge {
  return {
    id: edge.id,
    source: edge.source,
    target: edge.target,
    data: { weight: edge.weight, crossFrame: edge.crossFrame },
  };
}
