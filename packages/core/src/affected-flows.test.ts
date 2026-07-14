import { describe, expect, it } from "vitest";
import { computeAffectedFlows } from "./affected-flows";
import type { ChangedFile, GraphNode, LogicFlows } from "./index";

function node(
  id: string,
  kind: string,
  file: string,
  parentId: string | undefined,
  startLine: number,
  endLine: number,
): GraphNode {
  return {
    id,
    kind,
    qualifiedName: id,
    displayName: id,
    parentId,
    location: { file, startLine, endLine },
  };
}

describe("computeAffectedFlows", () => {
  it("includes callers of the exact changed block but excludes callers of an unchanged sibling", () => {
    const cartFile = "src/cartService.ts";
    const cartModule = node("ts:src/cartService.ts", "module", cartFile, undefined, 1, 40);
    const cartClass = node("ts:src/cartService.ts#CartService", "class", cartFile, cartModule.id, 3, 30);
    const addItem = node("ts:src/cartService.ts#CartService.addItem", "method", cartFile, cartClass.id, 10, 15);
    const getCart = node("ts:src/cartService.ts#CartService.getCart", "method", cartFile, cartClass.id, 20, 25);
    const updateCart = node("ts:src/cartRoutes.ts#updateCart", "function", "src/cartRoutes.ts", undefined, 5, 8);
    const placeOrder = node("ts:src/checkoutService.ts#placeOrder", "function", "src/checkoutService.ts", undefined, 5, 8);
    const nodes = [cartModule, cartClass, addItem, getCart, updateCart, placeOrder];
    const flows: LogicFlows = {
      [addItem.id]: [],
      [getCart.id]: [],
      [updateCart.id]: [{ kind: "call", label: "addItem", target: addItem.id, resolution: "resolved" }],
      [placeOrder.id]: [{ kind: "call", label: "getCart", target: getCart.id, resolution: "resolved" }],
    };
    const changedFiles: ChangedFile[] = [
      { path: cartFile, status: "modified", hunks: [{ start: 12, end: 12 }] },
    ];

    expect(computeAffectedFlows(nodes, flows, changedFiles)).toEqual([
      {
        flowId: addItem.id,
        ownerFile: cartFile,
        ownerChanged: true,
        changedFilesHit: [],
      },
      {
        flowId: updateCart.id,
        ownerFile: "src/cartRoutes.ts",
        ownerChanged: false,
        changedFilesHit: [cartFile],
      },
    ]);
  });
});
