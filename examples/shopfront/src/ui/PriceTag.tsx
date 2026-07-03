import type { ReactElement } from "react";
import type { Money } from "../domain/money.js";
import { formatMoney } from "../utils/legacy.js";

/** Props for the price tag: the money to render. */
export interface PriceTagProps {
  price: Money;
}

/** Renders a formatted price. Calls the god-module formatMoney directly from the UI. */
export function PriceTag({ price }: PriceTagProps): ReactElement {
  return <span className="price">{formatMoney(price)}</span>;
}
