/**
 * The node-type registry the standalone PR-review <ReactFlow> hands React Flow. The keys mirror the
 * types `layoutMinimalSubgraph` emits: `file` (a source file card), `package` (a group container), and
 * `MINIMAL_STUB_NODE` (the directional [+n] stub). All three components are store-free — they render
 * from their `data` prop alone, so the PR graph renders without the primary StoreContext's index.
 */

import { MINIMAL_STUB_NODE } from "../../layout/minimalSubgraphLayout";
import { PrModuleNode } from "./PrModuleNode";
import { PrPackageNode } from "./PrPackageNode";
import { PrStubNode } from "./PrStubNode";

export const PR_NODE_TYPES = {
  file: PrModuleNode,
  package: PrPackageNode,
  [MINIMAL_STUB_NODE]: PrStubNode,
};
