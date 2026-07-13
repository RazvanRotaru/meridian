import type { LoyaltyTier, RegisterRequest, User, UserId } from "../domain/user.js";
import { UserRepository } from "../repository/userRepository.js";
import { mintId } from "../utils/ids.js";
import { log } from "../utils/logger.js";

/** Owns the user lifecycle and identity lookups other services lean on. */
export class UserService {
  constructor(private readonly _users: UserRepository) {}

  /** Register a brand-new shopper. */
  register(request: RegisterRequest): User {
    const user: User = {
      id: mintId("user"),
      email: request.email,
      displayName: request.displayName,
      loyaltyTier: "none",
      address: null,
    };
    log(`registering ${user.email}`);
    return this._users.save(user);
  }

  /** Look up a shopper by id. */
  findById(id: UserId): User | undefined {
    return this._users.findById(id);
  }

  /** The email we should notify for a user, with a safe fallback. */
  emailFor(id: UserId): string {
    return this.findById(id)?.email ?? "unknown@example.com";
  }

  /** The loyalty tier that gates promotions, defaulting to none. */
  loyaltyTier(id: UserId): LoyaltyTier {
    return this.findById(id)?.loyaltyTier ?? "none";
  }
}
