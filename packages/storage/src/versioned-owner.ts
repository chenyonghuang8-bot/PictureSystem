import { performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";
import type { ControlRecoveryPermit } from "./control-coordinator.js";

/** Leases include read callbacks as well as admitted mutations. A generation
 * changes only after every old callback settles and the unique owner closes. */
export class VersionedOwner<T> {
  #value: T | undefined;
  #users = 0;
  #changing = false;
  #generation = 1n;
  constructor(
    initial: T,
    private readonly closeValue: (value: T) => void | Promise<void>,
  ) {
    this.#value = initial;
  }
  generation() {
    return this.#generation.toString();
  }
  isChanging() {
    return this.#changing;
  }
  isAvailable() {
    return this.#value !== undefined;
  }
  async withValue<R>(operation: (value: T) => Promise<R>): Promise<R> {
    const value = this.#value;
    if (this.#changing || value === undefined)
      throw new Error("OWNER_NOT_READY");
    this.#users++;
    try {
      return await operation(value);
    } finally {
      this.#users--;
    }
  }
  async replace(
    permit: ControlRecoveryPermit,
    create: () => Promise<T>,
    timeoutMs = 30_000,
  ): Promise<"READY" | "NOT_READY"> {
    if (
      !Number.isFinite(timeoutMs) ||
      timeoutMs < 0 ||
      timeoutMs > 30_000 ||
      this.#changing
    )
      throw new Error("OWNER_NOT_READY");
    this.#changing = true;
    try {
      const deadline = performance.now() + timeoutMs;
      while (this.#users > 0) {
        if (performance.now() >= deadline) return "NOT_READY";
        await delay(5);
      }
      return await permit.run("STARTUP_ASSESS", async () => {
        const old = this.#value;
        // A failed/partial close can never leave an old RW generation reachable.
        this.#value = undefined;
        if (old !== undefined) await this.closeValue(old);
        const fresh = await create();
        this.#value = fresh;
        this.#generation++;
        return "READY" as const;
      });
    } finally {
      this.#changing = false;
    }
  }
  async close() {
    if (this.#changing || this.#users > 0)
      throw new Error("OWNER_DRAIN_REQUIRED");
    const old = this.#value;
    this.#value = undefined;
    if (old !== undefined) await this.closeValue(old);
  }
}
