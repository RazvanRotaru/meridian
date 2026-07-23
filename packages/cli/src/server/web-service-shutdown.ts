import { HTTP_SERVICE_SHUTDOWN_MESSAGE } from "./http-service";
import { ServiceShutdownError } from "./service-shutdown";

export const WEB_SERVICE_SHUTDOWN_MESSAGE = HTTP_SERVICE_SHUTDOWN_MESSAGE;

export function isWebServiceShutdown(error: unknown): boolean {
  return error instanceof ServiceShutdownError;
}
