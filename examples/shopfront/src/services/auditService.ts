import type { Money } from "../domain/money.js";
import { Logger } from "../utils/logger.js";
import { formatMoney } from "../domain/money.js";
import { mintId } from "../utils/ids.js";

/** One recorded thing that happened, for the audit trail. */
export interface AuditEntry {
  id: string;
  action: string;
  detail: string;
}

/** Append-only audit log. Payments and checkout both write here. */
export class AuditService {
  private readonly log = new Logger("audit");
  private readonly entries: AuditEntry[] = [];

  /** Record an action with an arbitrary detail string. */
  record(action: string, detail: string): AuditEntry {
    const entry: AuditEntry = { id: mintId("audit"), action, detail };
    this.entries.push(entry);
    this.log.info(`${action}: ${detail}`);
    return entry;
  }

  /** Record an action whose detail is a monetary amount. */
  recordAmount(action: string, amount: Money): AuditEntry {
    return this.record(action, formatMoney(amount));
  }

  /** The full audit trail so far. */
  history(): AuditEntry[] {
    return [...this.entries];
  }
}
