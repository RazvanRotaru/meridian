import type { Order } from "../domain/order.js";
import { BaseRepository } from "./baseRepository.js";
import { formatMoney } from "../domain/money.js";
import { log } from "../utils/logger.js";

/** Stores placed orders in memory. */
export class OrderRepository extends BaseRepository<Order> {
  /** Persist an order and log its human-readable total. */
  record(order: Order): Order {
    log(`recording order ${order.id} for ${formatMoney(order.price.total)}`);
    return this.save(order);
  }

  /** Every order a given user has placed. */
  findByUser(userId: string): Order[] {
    return this.list().filter((order) => order.userId === userId);
  }

  /** Name used in base-class log lines. */
  protected label(): string {
    return "OrderRepository";
  }
}
