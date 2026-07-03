import type { User } from "../domain/user.js";
import { BaseRepository } from "./baseRepository.js";
import { log } from "../utils/logger.js";

/** Stores registered users in memory. */
export class UserRepository extends BaseRepository<User> {
  /** Find a user by their email address, or undefined. */
  findByEmail(email: string): User | undefined {
    const match = this.list().find((user) => user.email === email);
    if (!match) {
      log(`no user for email ${email}`, "warn");
    }
    return match;
  }

  /** Name used in base-class log lines. */
  protected label(): string {
    return "UserRepository";
  }
}
