import type { Money } from "../domain/money.js";
import { AuditService } from "./auditService.js";
import { formatMoney } from "../domain/money.js";
import { retry } from "../utils/retry.js";
import { log } from "../utils/logger.js";

/** The outcome of a charge attempt. */
export interface PaymentResult {
  ok: boolean;
  reference: string;
}

/** Charges cards (or pretends to) and audits every movement of money. */
export class PaymentService {
  constructor(private readonly _audit: AuditService) {}

  /** Charge a payment token, retrying transient failures, then audit it. */
  charge(token: string, amount: Money): PaymentResult {
    const result = retry(3, () => this.attempt(token, amount));
    this._audit.recordAmount("charge", amount);
    return result;
  }

  /** Refund a previous charge and audit the reversal. */
  refund(reference: string, amount: Money): void {
    this._audit.recordAmount("refund", amount);
    log(`refunding ${formatMoney(amount)} for ${reference}`);
  }

  /** A single charge attempt against the (imaginary) processor. */
  private attempt(token: string, amount: Money): PaymentResult {
    log(`charging ${formatMoney(amount)} to ${token}`);
    return { ok: true, reference: `pay_${token.slice(0, 6)}` };
  }
}
