import type { ProductId } from "../domain/product.js";
import type { SavedListItem } from "../domain/savedList.js";
import type { UserId } from "../domain/user.js";
import { deepClone, nowIso } from "../utils/legacy.js";
import { log } from "../utils/logger.js";

/** Stores each shopper's save-for-later choices in memory. */
export class SavedListRepository {
  private readonly byProductId = new Map<ProductId, SavedListItem>();

  /** Every product saved by one shopper, oldest first. */
  listForUser(userId: UserId): SavedListItem[] {
    return [...this.byProductId.values()]
      .filter((item) => item.userId === userId)
      .sort((left, right) => left.savedAt.localeCompare(right.savedAt))
      .map((item) => deepClone(item));
  }

  /** Whether a shopper already saved a product. */
  hasForUser(userId: UserId, productId: ProductId): boolean {
    return this.byProductId.get(productId)?.userId === userId;
  }

  /** Add or refresh a product in a shopper's saved list. */
  saveForUser(userId: UserId, productId: ProductId): SavedListItem {
    const item: SavedListItem = { userId, productId, savedAt: nowIso() };
    this.byProductId.set(productId, deepClone(item));
    log(`saved-list ${userId} added ${productId}`);
    return item;
  }

  /** Remove a product when it belongs to the requesting shopper. */
  removeForUser(userId: UserId, productId: ProductId): boolean {
    if (!this.hasForUser(userId, productId)) {
      return false;
    }
    log(`saved-list ${userId} removed ${productId}`);
    return this.byProductId.delete(productId);
  }
}
