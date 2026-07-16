export class ShadowedGate {
  private resolveReady!: () => void;
  private readonly ready = new Promise<void>((resolve) => {
    this.resolveReady = () => resolve(undefined);
  });

  wait(): Promise<void> {
    return this.ready;
  }

  settle(): void {
    this.resolveReady();
  }
}
