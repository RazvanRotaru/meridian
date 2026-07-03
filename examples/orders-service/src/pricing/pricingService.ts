import type { Order, OrderLine, OrderRequest } from "../domain/order.js";

const TAX_RATE = 0.2;

/** Turns a raw request into the money side of an order: subtotal, discount, tax, total. */
export class PricingService {
  /** Compute every monetary field for an order request. */
  price(request: OrderRequest): Pick<Order, "subtotalCents" | "discountCents" | "taxCents" | "totalCents"> {
    const subtotalCents = this.subtotal(request.lines);
    const discountCents = this.discountFor(subtotalCents, request.discountCode);
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
