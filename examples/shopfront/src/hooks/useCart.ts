import { useState } from "react";
import type { Cart } from "../domain/cart.js";
import { services } from "../app.js";
import { log } from "../utils/logger.js";

const DEFAULT_CART = "cart_demo";

/** Imperative cart operations exposed to components. */
export interface CartController {
  /** The current cart snapshot. */
  cart: Cart;
  /** A pre-formatted running total. */
  total: string;
  /** Add one unit of a product to the cart. */
  add(productId: string): void;
  /** Remove a product line from the cart. */
  remove(productId: string): void;
}

/** React hook: read the live cart and expose mutation actions to the UI. */
export function useCart(): CartController {
  const [cart, setCart] = useState<Cart>(() => services.cart.getCart(DEFAULT_CART));
  log("useCart render");
  return {
    cart,
    total: services.cart.summarize(DEFAULT_CART),
    add: (productId) => setCart(services.cart.addItem(DEFAULT_CART, productId, 1)),
    remove: (productId) => setCart(services.cart.removeItem(DEFAULT_CART, productId)),
  };
}
