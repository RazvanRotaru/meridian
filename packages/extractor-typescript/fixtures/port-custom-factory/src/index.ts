import { createBus } from "custom-bus";

const bus = createBus();
const alias = bus;

export function announceReady(): void {
  alias.emit("jobs:ready");
}
