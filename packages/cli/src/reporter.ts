/**
 * The stdout/stderr split the whole CLI obeys: human and progress text go to stderr; only a
 * machine payload (the `--json` summary) goes to stdout, so `blueprint ... --json` can be
 * piped without progress noise. `--quiet` silences the human channel but never the payload.
 */

export interface GlobalOptions {
  cwd?: string;
  json?: boolean;
  quiet?: boolean;
}

export class Reporter {
  private readonly quiet: boolean;
  private readonly json: boolean;

  constructor(globals: GlobalOptions) {
    this.quiet = Boolean(globals.quiet);
    this.json = Boolean(globals.json);
  }

  get jsonRequested(): boolean {
    return this.json;
  }

  /** Human / progress lines — stderr, suppressed under `--quiet`. */
  info(line: string): void {
    if (!this.quiet) {
      process.stderr.write(`${line}\n`);
    }
  }

  /** The machine payload — stdout, only when `--json` was requested. */
  payload(value: unknown): void {
    if (this.json) {
      process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
    }
  }
}
