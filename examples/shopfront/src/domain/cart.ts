import type { Money } from "./money.js";
import type { ProductId } from "./product.js";

/** A stable cart identifier (one per shopper session). */
export type CartId = string;

/** One product line inside a cart: which product, how many, at what unit price. */
export interface CartItem {
  productId: ProductId;
  quantity: number;
  unitPrice: Money;
}

/** A shopper's in-progress basket. `userId` is null until they sign in. */
export interface Cart {
  id: CartId;
  userId: string | null;
  items: CartItem[];
  updatedAt: string;
}
