import type { ProductId } from "./product.js";
import type { UserId } from "./user.js";

/** One product a shopper has put aside for later. */
export interface SavedListItem {
  userId: UserId;
  productId: ProductId;
  savedAt: string;
}

/** A saved item shaped for display without leaking catalog internals into React. */
export interface SavedProduct {
  productId: ProductId;
  title: string;
  formattedPrice: string;
  savedAt: string;
}
