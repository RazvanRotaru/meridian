import type { CartService } from "../services/index.js";
import { type ApiResponse, ok } from "./response.js";
import { log } from "../utils/logger.js";

/** HTTP front door for cart mutations. */
export class CartRoutes {
  constructor(private readonly _cart: CartService) {}

  /** GET /cart/:id — the cart plus its running total. */
  handleGetCart(cartId: string): ApiResponse {
    return ok({ cart: this._cart.getCart(cartId), total: this._cart.summarize(cartId) });
  }

  /** POST /cart/:id/items — add a product line. */
  handleAddItem(cartId: string, productId: string, quantity: number): ApiResponse {
    log(`POST /cart/${cartId}/items ${productId} x${quantity}`);
    return ok(this._cart.addItem(cartId, productId, quantity));
  }

  /** DELETE /cart/:id/items/:productId — remove a line. */
  handleRemoveItem(cartId: string, productId: string): ApiResponse {
    return ok(this._cart.removeItem(cartId, productId));
  }
}
