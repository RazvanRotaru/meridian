/** The orders API's HTTP surface — every entry port this system has. */

import express from "express";

interface StoredOrder {
  id: string;
  totalCents: number;
}

const orders = new Map<string, StoredOrder>();

export function buildServer(): unknown {
  const app = express();

  app.get("/api/orders", (_request: unknown, response: { json(body: unknown): void }) => {
    response.json([...orders.values()]);
  });

  app.get("/api/orders/:id", (request: { params: { id: string } }, response: { json(body: unknown): void }) => {
    response.json(orders.get(request.params.id) ?? null);
  });

  app.post("/api/orders", (_request: unknown, response: { json(body: unknown): void }) => {
    const order = { id: `ord_${orders.size + 1}`, totalCents: 0 };
    orders.set(order.id, order);
    response.json(order);
  });

  // No client in the linked system calls this — a dangling entry the graph should surface.
  app.delete("/api/orders/:id", (request: { params: { id: string } }, response: { json(body: unknown): void }) => {
    response.json(orders.delete(request.params.id));
  });

  return app;
}
