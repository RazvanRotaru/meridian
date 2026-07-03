/** A stable user identifier. */
export type UserId = string;

/** A shipping/billing address. */
export interface Address {
  line1: string;
  city: string;
  postcode: string;
  country: string;
}

/** A registered shopper. */
export interface User {
  id: UserId;
  email: string;
  displayName: string;
  loyaltyTier: LoyaltyTier;
  address: Address | null;
}

/** Loyalty tiers drive promotion eligibility. */
export type LoyaltyTier = "none" | "silver" | "gold";

/** What a caller submits to register a new shopper. */
export interface RegisterRequest {
  email: string;
  displayName: string;
}
