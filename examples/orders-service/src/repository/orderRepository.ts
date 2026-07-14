import type { Order } from "../domain/order.js";

/** Persistence contract. Expanding it in Meridian reveals the methods and their implementations. */
export interface OrderStore {
  save(order: Order): void;
  findById(id: string): Order | undefined;
  count(): number;
}

/** Stores orders and reads them back. In-memory stand-in for a database. */
export class OrderRepository implements OrderStore {
  private readonly byId = new Map<string, Order>();

  /** Persist an order so it can be looked up later. */
  save(order: Order): void {
    this.byId.set(order.id, order);
  }

  /** Find a previously saved order, or undefined if we have never seen it. */
  findById(id: string): Order | undefined {
    return this.byId.get(id);
  }

  /** How many orders we are currently holding. */
  count(): number {
    return this.byId.size;
  }
}
