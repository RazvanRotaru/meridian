/**
 * The ELK entry point. We run the bundled build on the main thread for v1: it is synchronous
 * enough for the graph sizes a single drill-down level produces, and it avoids worker-URL
 * plumbing that a browser-less build cannot exercise anyway. A worker is a later optimization.
 */

import ElkConstructor from "elkjs/lib/elk.bundled.js";
import type { ElkNode } from "elkjs/lib/elk-api";

const elk = new ElkConstructor();

export async function runElkLayout(graph: ElkNode): Promise<ElkNode> {
  return elk.layout(graph);
}
