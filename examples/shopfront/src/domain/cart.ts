import type { Money } from "./money.js";
import type { ProductId } from "./product.js";

/** A stable cart identifier (one per shopper session). */
export type CartId = string;

/** One product line inside a cart: which product, and how many. */
export interface CartItem {
  productId: ProductId;
  quantity: number;
  unitPrice: Money;
}

/** A shopper's in-progress basket. */
export interface Cart {
  id: CartId;
  userId: string | null;
  items: CartItem[];
  updatedAt: string;
}
