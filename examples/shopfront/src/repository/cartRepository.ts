import type { Cart } from "../domain/cart.js";
import { BaseRepository } from "./baseRepository.js";
import { nowIso, uuid } from "../utils/legacy.js";

/** Stores shopper carts in memory. */
export class CartRepository extends BaseRepository<Cart> {
  /** Fetch an existing cart or create+save a fresh empty one under the given id. */
  findOrCreate(id: string): Cart {
    const existing = this.findById(id);
    if (existing) {
      return existing;
    }
    return this.save({ id, userId: null, items: [], updatedAt: nowIso() });
  }

  /** Mint a brand-new cart with a generated id. */
  create(userId: string | null): Cart {
    return this.save({ id: uuid("cart"), userId, items: [], updatedAt: nowIso() });
  }

  /** Name used in base-class log lines. */
  protected label(): string {
    return "CartRepository";
  }
}
