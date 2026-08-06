import type { InventoryRecord } from "../domain/inventory.js";
import { BaseRepository } from "./baseRepository.js";
import { clamp } from "../utils/numbers.js";

/** InventoryRecord adapted to the base store's `id` contract via its productId. */
interface StoredInventory extends InventoryRecord {
  id: string;
}

/** Stores per-product stock levels in memory. */
export class InventoryRepository extends BaseRepository<StoredInventory> {
  /** Read the stock record for a product, defaulting to empty. */
  forProduct(productId: string): StoredInventory {
    return this.findById(productId) ?? { id: productId, productId, onHand: 0, reserved: 0 };
  }

  /** Move some quantity from on-hand to reserved, never going negative. */
  reserve(productId: string, quantity: number): StoredInventory {
    const record = this.forProduct(productId);
    const take = clamp(quantity, 0, record.onHand - record.reserved);
    return this.save({ ...record, reserved: record.reserved + take });
  }

  /** Name used in base-class log lines. */
  protected label(): string {
    return "InventoryRepository";
  }
}
