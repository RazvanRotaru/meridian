/**
 * Small, explicit adapters for synthetic execution scenarios.
 *
 * Route methods take several positional parameters while the experiment UI edits one JSON value.
 * Keeping that translation here makes the harness reviewable and leaves production APIs alone.
 */

import { buildShopfrontApp } from "./app.js";

export interface AddItemSyntheticInput {
  cartId: string;
  productId: string;
  quantity: number;
}

export function runHandleAddItem(input: AddItemSyntheticInput) {
  const app = buildShopfrontApp();
  return app.cartRoutes.handleAddItem(input.cartId, input.productId, input.quantity);
}
