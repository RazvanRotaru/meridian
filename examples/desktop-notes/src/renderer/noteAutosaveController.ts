/** Debounces editor changes and serializes autosaves so stale writes cannot overtake newer text. */

import type { AutosaveReceipt } from "./notesClient";

export type AutosaveWriter = (id: string, body: string, revision: number) => Promise<AutosaveReceipt>;

export interface AutosaveScheduler {
  schedule(delayMs: number, task: () => void): unknown;
  cancel(handle: unknown): void;
}

export type AutosaveState =
  | { status: "idle"; revision: number }
  | { status: "scheduled"; revision: number }
  | { status: "saving"; revision: number }
  | { status: "error"; revision: number; message: string };

const defaultScheduler: AutosaveScheduler = {
  schedule: (delayMs, task) => setTimeout(task, delayMs),
  cancel: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export class NoteAutosaveController {
  private body = "";
  private revision = 0;
  private savedRevision = 0;
  private timer: unknown | null = null;
  private pendingSave: Promise<void> | null = null;
  private disposed = false;
  private state: AutosaveState = { status: "idle", revision: 0 };

  public constructor(
    private readonly noteId: string,
    private readonly writer: AutosaveWriter,
    private readonly onState: (state: AutosaveState) => void = () => {},
    private readonly scheduler: AutosaveScheduler = defaultScheduler,
    private readonly debounceMs = 350,
  ) {}

  public get currentState(): AutosaveState {
    return this.state;
  }

  /** Record the latest editor value and replace any older debounce timer. */
  public updateBody(body: string): void {
    if (this.disposed) {
      throw new Error("cannot update a disposed autosave controller");
    }

    this.body = body;
    this.revision += 1;
    this.publish({ status: "scheduled", revision: this.revision });
    this.scheduleSave();
  }

  /** Save immediately. If a write is active, wait for it; its completion schedules newer text. */
  public flush(): Promise<void> {
    this.cancelTimer();
    if (this.disposed || this.revision <= this.savedRevision) {
      return Promise.resolve();
    }
    if (this.pendingSave !== null) {
      return this.pendingSave;
    }

    const revision = this.revision;
    const body = this.body;
    this.publish({ status: "saving", revision });

    const save = this.writer(this.noteId, body, revision)
      .then((receipt) => {
        this.savedRevision = Math.max(this.savedRevision, receipt.revision);
        if (this.revision === this.savedRevision) {
          this.publish({ status: "idle", revision: this.savedRevision });
        }
      })
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : "autosave failed";
        this.publish({ status: "error", revision, message });
      })
      .finally(() => {
        this.pendingSave = null;
        if (!this.disposed && this.revision > this.savedRevision && this.revision !== revision) {
          this.publish({ status: "scheduled", revision: this.revision });
          this.scheduleSave();
        }
      });

    this.pendingSave = save;
    return save;
  }

  public dispose(): void {
    this.disposed = true;
    this.cancelTimer();
  }

  private scheduleSave(): void {
    if (this.pendingSave !== null) {
      return;
    }
    this.cancelTimer();
    this.timer = this.scheduler.schedule(this.debounceMs, () => {
      this.timer = null;
      void this.flush();
    });
  }

  private cancelTimer(): void {
    if (this.timer === null) {
      return;
    }
    this.scheduler.cancel(this.timer);
    this.timer = null;
  }

  private publish(state: AutosaveState): void {
    this.state = state;
    this.onState(state);
  }
}
