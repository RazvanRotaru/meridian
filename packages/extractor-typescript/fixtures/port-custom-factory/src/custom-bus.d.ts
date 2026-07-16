declare module "custom-bus" {
  export interface Bus {
    emit(channel: string): void;
  }

  export function createBus(): Bus;
}
