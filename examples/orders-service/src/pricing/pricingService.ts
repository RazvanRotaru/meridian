import type { Order, OrderLine, OrderRequest } from "../domain/order.js";

const TAX_RATE = 0.2;

/** Loyalty-tier discount rate: gold customers get more off than silver. */
export function loyaltyDiscount(tier: string): number {
  if (tier === "gold") return 0.1;
  if (tier === "silver") return 0.05;
  return 0;
}

/** Turns a raw request into the money side of an order: subtotal, discount, tax, total. */
export class PricingService {
  /** Compute every monetary field for an order request. */
  price(
    request: OrderRequest,
    customerTier?: string,
  ): Pick<Order, "subtotalCents" | "discountCents" | "taxCents" | "totalCents"> {
    const subtotalCents = this.subtotal(request.lines);
    const codeDiscountCents = this.discountFor(subtotalCents, request.discountCode);
    const loyaltyDiscountCents = Math.round(subtotalCents * loyaltyDiscount(customerTier ?? ""));
    const discountCents = codeDiscountCents + loyaltyDiscountCents;
    const taxedBase = subtotalCents - discountCents;
    const taxCents = this.tax(taxedBase);
    return {
      subtotalCents,
      discountCents,
      taxCents,
      totalCents: taxedBase + taxCents,
    };
  }

  /** Add up the price of every line. */
  private subtotal(lines: OrderLine[]): number {
    return lines.reduce((sum, line) => sum + line.quantity * line.unitPriceCents, 0);
  }

  /** Apply a flat 10% discount when a known code is present. */
  private discountFor(subtotalCents: number, code: string | undefined): number {
    if (!code || !this.isKnownCode(code)) {
      return 0;
    }
    return Math.round(subtotalCents * 0.1);
  }

  /** Whether a discount code is one we honor. */
  private isKnownCode(code: string): boolean {
    return code === "WELCOME10" || code === "LOYAL10";
  }

  /** Sales tax on the post-discount amount. */
  private tax(baseCents: number): number {
    return Math.round(baseCents * TAX_RATE);
  }
}
