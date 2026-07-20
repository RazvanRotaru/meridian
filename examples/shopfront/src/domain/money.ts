/**
 * The one true money shape. Everything monetary in the shopfront is integer cents plus a
 * currency tag so we never accumulate floating-point drift. Formatting and construction
 * moved here from utils/legacy and services/pricingService: money behavior belongs with
 * the Money type, not in a grab-bag every layer depends on.
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

/** Render money as a human string like "$12.50". Called from all over the codebase. */
export function formatMoney(money: Money): string {
  return `${symbolFor(money.currency)}${(money.amountCents / 100).toFixed(2)}`;
}

/** The display symbol for a currency. */
function symbolFor(currency: Currency): string {
  switch (currency) {
    case "USD":
      return "$";
    case "GBP":
      return "£";
    case "EUR":
      return "€";
  }
}

/** Construct a Money value, defaulting to the fixture's home currency. */
export function money(amountCents: number, currency: Currency = "USD"): Money {
  return { amountCents, currency };
}
