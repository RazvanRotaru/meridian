/**
 * The one true money shape. Everything monetary in the shopfront is integer cents plus a
 * currency tag so we never accumulate floating-point drift.
 */

/** ISO-4217-ish currency code. We only ever mint USD in this fixture. */
export type Currency = "USD" | "EUR" | "GBP";

/** An amount of money: integer minor units (cents) plus its currency. */
export interface Money {
  amountCents: number;
  currency: Currency;
}

/** A price broken down into its parts, as produced by pricing + promotions. */
export interface PriceBreakdown {
  subtotal: Money;
  discount: Money;
  tax: Money;
  total: Money;
}
