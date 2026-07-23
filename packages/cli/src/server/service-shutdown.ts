/** Shared nominal boundary for shutdown cancellation across HTTP, admission, and repositories. */

export const SERVICE_SHUTDOWN_MESSAGE = "server is shutting down";

export class ServiceShutdownError extends Error {
  constructor(message = SERVICE_SHUTDOWN_MESSAGE) {
    super(message);
    this.name = "ServiceShutdownError";
  }
}
