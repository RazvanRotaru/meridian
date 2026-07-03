import type { RegisterRequest } from "../domain/user.js";
import type { NotificationService, UserService } from "../services/index.js";
import { type ApiResponse, created, ok } from "./response.js";
import { log } from "../utils/logger.js";

/** HTTP front door for user registration and lookup. */
export class UserRoutes {
  constructor(
    private readonly _users: UserService,
    private readonly _notifications: NotificationService,
  ) {}

  /** POST /users — register and welcome a new shopper. */
  handleRegister(request: RegisterRequest): ApiResponse {
    log(`POST /users ${request.email}`);
    const user = this._users.register(request);
    this._notifications.sendWelcome(user.id);
    return created(user);
  }

  /** GET /users/:id — fetch a shopper. */
  handleGetUser(id: string): ApiResponse {
    const user = this._users.findById(id);
    if (!user) {
      return { status: 404, body: { error: "no such user" } };
    }
    return ok(user);
  }
}
