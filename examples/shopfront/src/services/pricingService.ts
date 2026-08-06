import type { Cart, CartItem } from "../domain/cart.js";
import { formatMoney, money, type Money, type PriceBreakdown } from "../domain/money.js";
import type { PromotionService } from "./promotionService.js";
import { clamp } from "../utils/numbers.js";
import { sum } from "../utils/collections.js";
import { log } from "../utils/logger.js";

const TAX_RATE = 0.2;

/**
 * Computes every monetary field for a cart. Half of a deliberate cycle: priceCart() calls
 * PromotionService.apply(), which calls back into basePrice() below.
 */
export class PricingService {
  private _promotion!: PromotionService;

  /** Late-bind the promotion service to break the construction cycle. */
  setPromotion(promotion: PromotionService): void {
    this._promotion = promotion;
  }

  /** Price a whole cart: subtotal, promotion discount, tax, total. */
  priceCart(cart: Cart): PriceBreakdown {
    const subtotalCents = sum(cart.items.map((item) => this.basePrice(item).amountCents));
    const discountCents = this._promotion.apply(cart, subtotalCents);
    const taxedBase = clamp(subtotalCents - discountCents, 0, subtotalCents);
    const taxCents = this.tax(taxedBase);
    log(`priced cart ${cart.id}: ${formatMoney(money(taxedBase + taxCents))}`);
    return {
      subtotal: money(subtotalCents),
      discount: money(discountCents),
      tax: money(taxCents),
      total: money(taxedBase + taxCents),
    };
  }

  /** The pre-discount price of a single line — the cycle re-entry point from promotions. */
  basePrice(item: CartItem): Money {
    const amountCents = item.unitPrice.amountCents * clamp(item.quantity, 1, 999);
    return { amountCents, currency: item.unitPrice.currency };
  }

  /** Sales tax on a post-discount base. */
  private tax(baseCents: number): number {
    return Math.round(baseCents * TAX_RATE);
  }
}
