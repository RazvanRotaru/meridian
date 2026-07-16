type LifecycleEvent =
  | { readonly type: "ready" }
  | { readonly type: "settled" }
  | { readonly type: "ambiguous-handler" }
  | { readonly type: "conditional-handler" };

type LifecycleType = LifecycleEvent["type"];
type Handler<T extends LifecycleType> = (event: Extract<LifecycleEvent, { type: T }>) => void;

function createDispatcher() {
  type ErasedHandler = (event: LifecycleEvent) => void;
  const handlers = new Map<LifecycleType, Set<ErasedHandler>>();

  const receive = (event: MessageEvent): void => {
    const payload = event.data as Partial<LifecycleEvent> | undefined;
    const discriminator = payload?.type;
    if (discriminator === undefined) return;
    const bucket = handlers.get(discriminator);
    if (!bucket) return;
    for (const handler of bucket) handler(payload as LifecycleEvent);
  };
  window.addEventListener("message", receive);

  const on = <T extends LifecycleType>(type: T, handler: Handler<T>): (() => void) => {
    let bucket = handlers.get(type);
    if (!bucket) {
      bucket = new Set();
      handlers.set(type, bucket);
    }
    bucket.add(handler as ErasedHandler);
    return () => bucket?.delete(handler as ErasedHandler);
  };

  const once = <T extends LifecycleType>(type: T, handler: Handler<T>): (() => void) => {
    const unsubscribe = on(type, (event) => {
      unsubscribe();
      handler(event);
    });
    return unsubscribe;
  };

  const unrelated = (type: LifecycleType, handler: Handler<LifecycleType>): void => {
    console.info(type);
    handler({ type: "ready" });
  };

  return { on, once, unrelated };
}

export function wireLifecycle(): void {
  const events = createDispatcher();
  events.on("ready", () => {
    const handleReadyFlow = (): void => undefined;
    handleReadyFlow();
  });
  events.once("settled", () => {
    const handleSettledFlow = (): void => undefined;
    handleSettledFlow();
  });
  events.on("ambiguous-handler", () => {
    const firstFlow = (): void => undefined;
    const secondFlow = (): void => undefined;
    firstFlow();
    secondFlow();
  });
  events.on("conditional-handler", () => {
    const conditionalFlow = (): void => undefined;
    if (Date.now() > 0) conditionalFlow();
  });
}

export function wireDynamic(type: LifecycleType): void {
  const events = createDispatcher();
  events.on(type, () => undefined);
}

export function callUnrelated(): void {
  const events = createDispatcher();
  events.unrelated("ready", () => undefined);
}

function createAmbiguousDispatcher() {
  const handlers = new Map<string, Set<(event: MessageEvent) => void>>();
  const first = (event: MessageEvent): void => handlers.get(event.data?.type)?.forEach((handler) => handler(event));
  const second = (event: MessageEvent): void => handlers.get(event.data?.kind)?.forEach((handler) => handler(event));
  window.addEventListener("message", first);
  window.addEventListener("message", second);
  const on = (type: string, handler: (event: MessageEvent) => void): void => {
    const bucket = handlers.get(type) ?? new Set();
    bucket.add(handler);
    handlers.set(type, bucket);
  };
  return { on };
}

export function wireAmbiguous(): void {
  const events = createAmbiguousDispatcher();
  events.on("ambiguous", () => undefined);
}
