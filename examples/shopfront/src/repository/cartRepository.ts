import type { Cart } from "../domain/cart.js";
import { BaseRepository } from "./baseRepository.js";
import { nowIso } from "../utils/clock.js";
import { mintId } from "../utils/ids.js";

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
    return this.save({ id: mintId("cart"), userId, items: [], updatedAt: nowIso() });
  }

  /** Name used in base-class log lines. */
  protected label(): string {
    return "CartRepository";
  }
}
