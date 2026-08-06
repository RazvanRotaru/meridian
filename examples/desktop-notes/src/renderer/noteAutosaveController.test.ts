import {
  NoteAutosaveController,
  type AutosaveScheduler,
  type AutosaveState,
  type AutosaveWriter,
} from "./noteAutosaveController";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

function equal(actual: unknown, expected: unknown): void {
  assert(Object.is(actual, expected), `expected ${String(expected)}, received ${String(actual)}`);
}

function deepEqual(actual: unknown, expected: unknown): void {
  const actualJson = JSON.stringify(actual);
  const expectedJson = JSON.stringify(expected);
  assert(actualJson === expectedJson, `expected ${expectedJson}, received ${actualJson}`);
}

async function check(name: string, testBody: () => Promise<void>): Promise<void> {
  await testBody();
  console.log(`ok - ${name}`);
}

class ManualScheduler implements AutosaveScheduler {
  private sequence = 0;
  private readonly tasks = new Map<number, () => void>();

  public get pendingCount(): number {
    return this.tasks.size;
  }

  public schedule(_delayMs: number, task: () => void): number {
    const handle = ++this.sequence;
    this.tasks.set(handle, task);
    return handle;
  }

  public cancel(handle: unknown): void {
    this.tasks.delete(handle as number);
  }

  public runNext(): void {
    const next = this.tasks.entries().next().value as [number, () => void] | undefined;
    assert(next, "expected a scheduled autosave");
    this.tasks.delete(next[0]);
    next[1]();
  }
}

async function run(): Promise<void> {
  await check("coalesces rapid edits and saves only the newest body", async () => {
    const scheduler = new ManualScheduler();
    const calls: Array<{ id: string; body: string; revision: number }> = [];
    const states: AutosaveState[] = [];
    const writer: AutosaveWriter = async (id, body, revision) => {
      calls.push({ id, body, revision });
      return { noteId: id, revision, savedAt: 1_700_000_000_000 };
    };
    const controller = new NoteAutosaveController("note-7", writer, (state) => states.push(state), scheduler, 250);

    controller.updateBody("A");
    controller.updateBody("A better");
    controller.updateBody("A better draft");

    equal(scheduler.pendingCount, 1);
    scheduler.runNext();
    await controller.flush();
    deepEqual(calls, [{ id: "note-7", body: "A better draft", revision: 3 }]);
    deepEqual(controller.currentState, { status: "idle", revision: 3 });
    equal(states.some((state) => state.status === "saving"), true);
  });

  await check("serializes an edit made while the previous revision is in flight", async () => {
    const scheduler = new ManualScheduler();
    const calls: Array<{ body: string; revision: number }> = [];
    let finishFirst: (() => void) | undefined;
    const writer: AutosaveWriter = (id, body, revision) => {
      calls.push({ body, revision });
      if (revision > 1) {
        return Promise.resolve({ noteId: id, revision, savedAt: 1_700_000_000_002 });
      }
      return new Promise((resolve) => {
        finishFirst = () => resolve({ noteId: id, revision, savedAt: 1_700_000_000_001 });
      });
    };
    const controller = new NoteAutosaveController("note-9", writer, () => {}, scheduler, 250);

    controller.updateBody("first");
    scheduler.runNext();
    const firstSave = controller.flush();
    controller.updateBody("second");
    equal(scheduler.pendingCount, 0);

    assert(finishFirst, "expected the first save to be in flight");
    finishFirst();
    await firstSave;
    equal(scheduler.pendingCount, 1);

    scheduler.runNext();
    await controller.flush();
    deepEqual(calls, [
      { body: "first", revision: 1 },
      { body: "second", revision: 2 },
    ]);
  });
}

void run();
