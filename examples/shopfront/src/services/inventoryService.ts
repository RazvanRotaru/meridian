import type { StockLevel } from "../domain/inventory.js";
import { InventoryRepository } from "../repository/inventoryRepository.js";
import { clamp } from "../utils/legacy.js";
import { log } from "../utils/logger.js";

/** Turns raw stock records into stock signals and holds stock during checkout. */
export class InventoryService {
  constructor(private readonly _inventory: InventoryRepository) {}

  /** The coarse stock signal for a product. */
  stockLevel(productId: string): StockLevel {
    const record = this._inventory.forProduct(productId);
    const available = clamp(record.onHand - record.reserved, 0, record.onHand);
    if (available <= 0) {
      return "out";
    }
    return available < 5 ? "low" : "in";
  }

  /** Whether a product can be added to a cart at all. */
  inStock(productId: string): boolean {
    return this.stockLevel(productId) !== "out";
  }

  /** Reserve stock for checkout; returns whether the hold succeeded. */
  reserveStock(productId: string, quantity: number): boolean {
    if (!this.inStock(productId)) {
      log(`out of stock: ${productId}`, "warn");
      return false;
    }
    this._inventory.reserve(productId, quantity);
    return true;
  }
}
