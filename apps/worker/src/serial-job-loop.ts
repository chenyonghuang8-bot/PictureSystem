import { setTimeout as delay } from "node:timers/promises";

/** Stop interrupts idle waits only; current native/SQL operations must settle. */
export class SerialJobLoop {
  protected stopping = false;
  private readonly idle = new AbortController();
  private completion?: Promise<void>;
  constructor(private readonly operation: () => Promise<void>) {}
  start(): Promise<void> {
    if (this.completion) return this.completion;
    this.completion = this.execute();
    return this.completion;
  }
  private async execute() {
    while (!this.stopping) await this.operation();
  }
  requestStop() {
    this.stopping = true;
    this.idle.abort();
  }
  async drain() {
    await this.completion;
  }
  async wait(milliseconds: number) {
    if (this.stopping) return;
    try {
      await delay(milliseconds, undefined, { signal: this.idle.signal });
    } catch (error) {
      if (!this.stopping) throw error;
    }
  }
  get stopped() {
    return this.stopping;
  }
}
