/** A minimal but fully valid GraphArtifact for tests; each call returns a fresh clone. */

import type { GraphArtifact } from "../types";

const PLACE_ORDER = "ts:src/services/orderService.ts#OrderService.placeOrder";
const GET_ORDER = "ts:src/services/orderService.ts#OrderService.getOrder";

const template: GraphArtifact = {
  schemaVersion: "1.0.0",
  generatedAt: "2026-01-01T00:00:00.000Z",
  generator: { name: "blueprint", version: "0.1.0" },
  target: { name: "orders-service", root: "examples/orders-service", language: "typescript" },
  telemetry: {
    joinKey: "node.id",
    requiredRuntimeAttributes: ["service.name", "deployment.environment.name"],
    serviceDefaulting: "forbidden",
  },
  nodes: [
    node("ts:src/services", "package", "services", "services", null),
    node("ts:src/services/orderService.ts", "module", "orderService", "orderService", "ts:src/services"),
    node(
      "ts:src/services/orderService.ts#OrderService",
      "class",
      "OrderService",
      "OrderService",
      "ts:src/services/orderService.ts",
    ),
    method(PLACE_ORDER, "OrderService.placeOrder", "placeOrder"),
    method(GET_ORDER, "OrderService.getOrder", "getOrder"),
  ],
  edges: [
    {
      id: `calls@${PLACE_ORDER}|${GET_ORDER}`,
      source: PLACE_ORDER,
      target: GET_ORDER,
      kind: "calls",
      resolution: "resolved",
      weight: 1,
      callSites: [{ file: "src/services/orderService.ts", line: 20 }],
    },
  ],
};

function node(
  id: string,
  kind: string,
  qualifiedName: string,
  displayName: string,
  parentId: string | null,
): GraphArtifact["nodes"][number] {
  return { id, kind, qualifiedName, displayName, parentId, location: { file: "src/services/orderService.ts", startLine: 1 } };
}

function method(id: string, qualifiedName: string, displayName: string): GraphArtifact["nodes"][number] {
  return {
    ...node(id, "method", qualifiedName, displayName, "ts:src/services/orderService.ts#OrderService"),
    telemetry: { codeNamespace: "OrderService", codeFunction: displayName, spanNameHints: [qualifiedName, displayName] },
  };
}

export function validArtifact(): GraphArtifact {
  return structuredClone(template);
}
