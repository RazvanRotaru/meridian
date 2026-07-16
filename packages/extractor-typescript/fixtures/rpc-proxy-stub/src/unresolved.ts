import { RemoteFactory, type RemoteService } from "missing-rpc-package";

class RemoteReceiver {
  async ping(): Promise<void> {}
}

export function wireUnresolvedDependency(receiver: RemoteReceiver): void {
  const factory = new RemoteFactory();
  const { proxy: remote } = factory.createProxy<RemoteService>("remote");
  void remote.ping();
  factory.createStub("remote", (method: string, args: unknown[]) =>
    (receiver as any)[method](...args));
}
