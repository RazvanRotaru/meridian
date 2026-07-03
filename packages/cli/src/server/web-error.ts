/**
 * A request-shaped failure the web server maps straight to an HTTP status.
 *
 * The `view` command speaks in process exit codes (`CliError`); the web server speaks in HTTP
 * statuses instead, so bad input becomes a 400 and a failed clone/extract a 422 rather than
 * killing the long-lived process. Messages here are already safe to return to the browser.
 */

export class WebError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "WebError";
    this.status = status;
  }
}
