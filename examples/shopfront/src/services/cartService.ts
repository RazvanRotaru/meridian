import type { Cart, CartId } from "../domain/cart.js";
import { CartRepository } from "../repository/cartRepository.js";
import { CatalogService } from "./catalogService.js";
import { InventoryService } from "./inventoryService.js";
import { PricingService } from "./pricingService.js";
import { formatMoney } from "../domain/money.js";
import { clamp } from "../utils/numbers.js";
import { nowIso } from "../utils/clock.js";
import { sum } from "../utils/collections.js";
import { log } from "../utils/logger.js";

/** Mutates carts and answers "how much is in here?" — leans on catalog, inventory, pricing. */
export class CartService {
  constructor(
    private readonly _carts: CartRepository,
    private readonly _catalog: CatalogService,
    private readonly _inventory: InventoryService,
    private readonly _pricing: PricingService,
  ) {}

  /** The current cart for an id, created empty if it does not exist yet. */
  getCart(id: CartId): Cart {
    return this._carts.findOrCreate(id);
  }

  /** Add a product to a cart, subject to catalog existence and stock. */
  addItem(cartId: CartId, productId: string, quantity: number): Cart {
    const cart = this.getCart(cartId);
    const product = this._catalog.getProduct(productId);
    if (!product || !this._inventory.inStock(productId)) {
      log(`cannot add ${productId}`, "warn");
      return cart;
    }
    const items = [...cart.items, { productId, quantity: clamp(quantity, 1, 99), unitPrice: product.price }];
    return this._carts.save({ ...cart, items, updatedAt: nowIso() });
  }

  /** Remove a product line from a cart. */
  removeItem(cartId: CartId, productId: string): Cart {
    const cart = this.getCart(cartId);
    const items = cart.items.filter((item) => item.productId !== productId);
    return this._carts.save({ ...cart, items, updatedAt: nowIso() });
  }

  /** A pre-formatted running total for the cart panel (routes through pricing). */
  summarize(cartId: CartId): string {
    const breakdown = this._pricing.priceCart(this.getCart(cartId));
    return formatMoney(breakdown.total);
  }

  /** Total number of units in the cart. */
  itemCount(cartId: CartId): number {
    return sum(this.getCart(cartId).items.map((item) => item.quantity));
  }
}
