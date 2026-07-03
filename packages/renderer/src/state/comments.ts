/**
 * The comments layer: node-anchored review notes, persisted in localStorage per artifact
 * target (no backend, honestly local — the same seam a server store can replace later).
 * Counts roll up through `parentId` so a collapsed package wears the total of everything
 * commented inside it.
 */

import type { GraphIndex } from "../graph/graphIndex";

export interface NodeComment {
  id: string;
  author: string;
  text: string;
  createdAt: string;
  resolved: boolean;
}

export type CommentsByNode = Record<string, NodeComment[]>;

const STORAGE_PREFIX = "meridian.comments.";

export function loadComments(targetName: string): CommentsByNode {
  try {
    const raw = window.localStorage.getItem(STORAGE_PREFIX + targetName);
    const parsed: unknown = raw ? JSON.parse(raw) : null;
    return isCommentsByNode(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

export function saveComments(targetName: string, comments: CommentsByNode): void {
  try {
    window.localStorage.setItem(STORAGE_PREFIX + targetName, JSON.stringify(comments));
  } catch {
    // Storage full/blocked: comments stay in-memory for the session; never crash the canvas.
  }
}

export function newComment(text: string): NodeComment {
  return {
    id: `c_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
    author: "you",
    text,
    createdAt: new Date().toISOString(),
    resolved: false,
  };
}

/** node.id -> unresolved comment count at-or-below it (containers roll up their subtree). */
export function rollupCommentCounts(
  comments: CommentsByNode,
  index: GraphIndex,
): ReadonlyMap<string, number> {
  const counts = new Map<string, number>();
  for (const [nodeId, nodeComments] of Object.entries(comments)) {
    const open = nodeComments.filter((comment) => !comment.resolved).length;
    if (open === 0) {
      continue;
    }
    for (const ancestor of index.ancestorsOf(nodeId)) {
      counts.set(ancestor.id, (counts.get(ancestor.id) ?? 0) + open);
    }
    if (!index.nodesById.has(nodeId)) {
      counts.set(nodeId, (counts.get(nodeId) ?? 0) + open);
    }
  }
  return counts;
}

function isCommentsByNode(value: unknown): value is CommentsByNode {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
