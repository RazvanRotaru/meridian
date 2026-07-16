export class RegistrationGate {
  private resolveRegistration!: () => void;
  private rejectRegistration!: (error: Error) => void;
  private readonly registrationReady = new Promise<void>((resolve, reject) => {
    this.resolveRegistration = resolve;
    this.rejectRegistration = reject;
  });

  acknowledge(error?: string): void {
    if (error) {
      this.rejectRegistration(new Error(error));
    } else {
      this.resolveRegistration();
    }
  }

  waitForRegistration(): Promise<void> {
    return this.registrationReady;
  }
}

export function returnedAlias(gate: RegistrationGate): Promise<void> {
  return gate.waitForRegistration();
}

export async function bootstrap(gate: RegistrationGate): Promise<void> {
  await returnedAlias(gate);
  restoreInitialSession();
}

function restoreInitialSession(): void {}

export function unobservedPromise(): number {
  const ignored = new Promise<void>(() => {});
  return ignored instanceof globalThis.Promise ? 1 : 0;
}

export class ReassignedGate {
  private resolveFirst!: () => void;
  private resolveSecond!: () => void;
  private ready: Promise<void>;

  constructor() {
    this.ready = new Promise<void>((resolve) => {
      this.resolveFirst = resolve;
    });
    this.ready = new Promise<void>((resolve) => {
      this.resolveSecond = resolve;
    });
  }

  wait(): Promise<void> {
    return this.ready;
  }

  settleFirst(): void {
    this.resolveFirst();
  }

  settleSecond(): void {
    this.resolveSecond();
  }
}

export async function awaitReassigned(gate: ReassignedGate): Promise<void> {
  await gate.wait();
}

export class MutableOverwriteGate {
  private resolveReady!: () => void;
  private ready: Promise<void>;

  constructor() {
    this.ready = new Promise<void>((resolve) => {
      this.resolveReady = resolve;
    });
  }

  replace(): void {
    this.ready = Promise.resolve();
  }

  wait(): Promise<void> {
    return this.ready;
  }

  settle(): void {
    this.resolveReady();
  }
}

export async function awaitMutable(gate: MutableOverwriteGate): Promise<void> {
  await gate.wait();
}

export class NestedCallbackGate {
  private resolveReady!: () => void;
  private readonly ready = new Promise<void>((resolve) => {
    this.resolveReady = resolve;
  });

  inspect(): void {
    const unindexedCallback = async (): Promise<void> => {
      await this.ready;
      return this.ready;
    };
    void unindexedCallback;
  }

  settle(): void {
    this.resolveReady();
  }
}

export class ExplicitGlobalGate {
  private resolveReady!: () => void;
  private readonly ready = new globalThis.Promise<void>((resolve) => {
    this.resolveReady = resolve;
  });

  wait(): Promise<void> {
    return this.ready;
  }

  settle(): void {
    this.resolveReady();
  }
}

export async function awaitExplicitGlobal(gate: ExplicitGlobalGate): Promise<void> {
  await gate.wait();
}
