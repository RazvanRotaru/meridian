type ServiceHandler = (method: string, args: unknown[]) => unknown;

interface NotesService {
  save(note: string): Promise<void>;
  remove(id: string): Promise<void>;
}

class RpcFactory {
  createProxy<T extends object>(_service: string): { proxy: T; dispose: () => void } {
    throw new Error("fixture only");
  }

  createStub(_service: string, _handler: ServiceHandler): { dispose: () => void } {
    throw new Error("fixture only");
  }
}

class NotesReceiver {
  async save(_note: string): Promise<void> {}
  async remove(_id: string): Promise<void> {}
  private async secret(): Promise<void> {}
  static helper(): void {}
}

function callForwarded(service: NotesService): void {
  void service.remove("old");
}

export function wire(factory: RpcFactory, receiver: NotesReceiver): void {
  const { proxy: notes } = factory.createProxy<NotesService>("notes");
  void notes.save("draft");
  callForwarded(notes);
  factory.createStub("notes", (method, args) => (receiver as any)[method](...args));
}

export function dynamicService(factory: RpcFactory, receiver: NotesReceiver, service: string): void {
  const { proxy: client } = factory.createProxy<NotesService>(service);
  void client.save("not correlated");
  factory.createStub(service, (method, args) => (receiver as any)[method](...args));
}

class OtherReceiver {
  async save(_note: string): Promise<void> {}
}

export function ambiguousReceiver(
  factory: RpcFactory,
  receiver: NotesReceiver | OtherReceiver,
): void {
  factory.createStub("ambiguous", (method, args) => (receiver as any)[method](...args));
}

class CoincidentalFactory {
  createProxy<T>(): { value: T } {
    throw new Error("not RPC");
  }

  createStub(_name: string, _value: unknown): void {}
}

export function coincidental(factory: CoincidentalFactory): void {
  factory.createProxy<NotesService>();
}
