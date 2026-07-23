import { useState } from "react";
import type { ProductId } from "../domain/product.js";
import type { SavedProduct } from "../domain/savedList.js";
import type { UserId } from "../domain/user.js";
import { services } from "../app.js";
import { log } from "../utils/logger.js";

const DEMO_USER: UserId = "user_demo";

/** Saved-product state and actions exposed to the catalog page. */
export interface SavedItemsController {
  items: SavedProduct[];
  productIds: ReadonlySet<ProductId>;
  save(productId: ProductId): void;
  remove(productId: ProductId): void;
}

/** React hook: keep one shopper's save-for-later list in sync with service mutations. */
export function useSavedItems(userId: UserId = DEMO_USER): SavedItemsController {
  const [items, setItems] = useState<SavedProduct[]>(() => services.savedList.list(userId));
  const productIds = new Set(items.map((item) => item.productId));

  return {
    items,
    productIds,
    save: (productId) => {
      const result = services.savedList.save(userId, productId);
      if (!result.ok) {
        log(result.error, "warn");
        return;
      }
      setItems((current) => {
        const withoutPrevious = current.filter((item) => item.productId !== productId);
        return [...withoutPrevious, result.value];
      });
    },
    remove: (productId) => setItems(services.savedList.remove(userId, productId)),
  };
}
