import type { ProductId } from "../domain/product.js";
import type { SavedListItem, SavedProduct } from "../domain/savedList.js";
import type { UserId } from "../domain/user.js";
import { SavedListRepository } from "../repository/savedListRepository.js";
import type { Result } from "../utils/result.js";
import { err, ok } from "../utils/result.js";
import { log } from "../utils/logger.js";
import { CatalogService } from "./catalogService.js";

/** Owns the per-user save-for-later workflow and resolves current catalog display data. */
export class SavedListService {
  constructor(
    private readonly _savedLists: SavedListRepository,
    private readonly _catalog: CatalogService,
  ) {}

  /** Products currently saved by one shopper, omitting catalog entries that disappeared. */
  list(userId: UserId): SavedProduct[] {
    return this._savedLists
      .listForUser(userId)
      .map((item) => this.toSavedProduct(item))
      .filter((item): item is SavedProduct => item !== null);
  }

  /** Save an active catalog product for one shopper. */
  save(userId: UserId, productId: ProductId): Result<SavedProduct> {
    const product = this._catalog.getProduct(productId);
    if (!product?.active) {
      return err(`product ${productId} is not available`);
    }

    const saved = this._savedLists.saveForUser(userId, productId);
    const view = this.toSavedProduct(saved);
    if (!view) {
      return err(`product ${productId} could not be loaded`);
    }
    log(`save-for-later completed for ${userId}`);
    return ok(view);
  }

  /** Remove one product from a shopper's saved list and return the refreshed view. */
  remove(userId: UserId, productId: ProductId): SavedProduct[] {
    this._savedLists.removeForUser(userId, productId);
    return this.list(userId);
  }

  /** Whether the saved list contains a product for this shopper. */
  contains(userId: UserId, productId: ProductId): boolean {
    return this._savedLists.hasForUser(userId, productId);
  }

  private toSavedProduct(item: SavedListItem): SavedProduct | null {
    const product = this._catalog.getProduct(item.productId);
    if (!product?.active) {
      return null;
    }
    const view = this._catalog.toView(product);
    return {
      productId: item.productId,
      title: view.title,
      formattedPrice: view.formattedPrice,
      savedAt: item.savedAt,
    };
  }
}
