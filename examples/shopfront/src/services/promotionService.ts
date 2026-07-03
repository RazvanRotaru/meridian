import type { Cart } from "../domain/cart.js";
import { PricingService } from "./pricingService.js";
import { UserService } from "./userService.js";
import { clamp, sum } from "../utils/legacy.js";
import { log } from "../utils/logger.js";

/**
 * Computes discounts. The other half of the cycle: apply() calls back into
 * PricingService.basePrice() to floor the discount at the un-promoted line total.
 */
export class PromotionService {
  constructor(
    private readonly _pricing: PricingService,
    private readonly _users: UserService,
  ) {}

  /** Compute the discount (in cents) to apply to a cart's subtotal. */
  apply(cart: Cart, subtotalCents: number): number {
    const lineFloor = sum(cart.items.map((item) => this._pricing.basePrice(item).amountCents));
    const tierBonus = this.tierDiscount(cart.userId);
    const raw = Math.round(subtotalCents * this.rate(cart)) + tierBonus;
    const capped = clamp(raw, 0, lineFloor);
    log(`promotion on ${cart.id}: -${capped}`);
    return capped;
  }

  /** The named campaigns a cart currently qualifies for. */
  eligibleCampaigns(cart: Cart): string[] {
    return cart.items.length > 0 ? ["auto", ...this.tierCampaigns(cart.userId)] : [];
  }

  /** Percentage discount rate, higher for fuller carts. */
  private rate(cart: Cart): number {
    return cart.items.length >= 3 ? 0.1 : 0.05;
  }

  /** A flat loyalty bonus for gold-tier shoppers. */
  private tierDiscount(userId: string | null): number {
    if (!userId) {
      return 0;
    }
    return this._users.loyaltyTier(userId) === "gold" ? 500 : 0;
  }

  /** Campaign labels unlocked by loyalty tier. */
  private tierCampaigns(userId: string | null): string[] {
    return userId && this._users.loyaltyTier(userId) !== "none" ? ["loyalty"] : [];
  }
}
