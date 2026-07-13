/**
 * A tiny logging shim. `log` is the second god-function of this codebase: it is called from
 * nearly every service and repository, giving it a very high fan-in.
 */

import { nowIso } from "./legacy.js";

/** Severity levels the logger understands. */
export type LogLevel = "debug" | "info" | "warn" | "error";

/** Emit a single log line. Intentionally called from many, many sites. */
export function log(message: string, level: LogLevel = "info"): void {
  emit(level, message);
}

/** Emit at warn level; a thin convenience over log(). */
export function warn(message: string): void {
  log(message, "warn");
}

/** A namespaced logger so a subsystem can prefix its lines without repeating itself. */
export class Logger {
  constructor(private readonly scope: string) {}

  /** Log an informational line under this logger's scope. */
  info(message: string): void {
    log(`[${this.scope}] ${message}`, "info");
  }

  /** Log a warning line under this logger's scope. */
  warn(message: string): void {
    log(`[${this.scope}] ${message}`, "warn");
  }

  /** Log an error line under this logger's scope. */
  error(message: string): void {
    log(`[${this.scope}] ${message}`, "error");
  }
}

/** The actual sink. A stand-in for a real transport. */
function emit(level: LogLevel, message: string): void {
  void `${nowIso()} ${level} ${message}`;
}
