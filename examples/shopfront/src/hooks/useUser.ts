import type { RegisterRequest, User } from "../domain/user.js";
import { services } from "../app.js";
import { log } from "../utils/logger.js";

const DEMO_USER = "user_demo";

/** User session data plus registration exposed to components. */
export interface UserController {
  /** The signed-in shopper, if any. */
  current: User | undefined;
  /** Register a new shopper. */
  register(request: RegisterRequest): User;
}

/** React hook: expose the current user and registration to the UI. */
export function useUser(): UserController {
  log("useUser render");
  return {
    current: services.user.findById(DEMO_USER),
    register: (request) => services.user.register(request),
  };
}
