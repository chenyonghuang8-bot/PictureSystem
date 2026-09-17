import type { Lock, Locker } from "@tus/server";

type Waiter = {
  resolve: () => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
  signal: AbortSignal;
  onAbort: () => void;
};

type Entry = { locked: boolean; waiters: Waiter[] };

export class UploadLockError extends Error {
  readonly status_code = 429;
  readonly body = "RATE_LIMITED\n";

  constructor() {
    super("UPLOAD_LOCK_UNAVAILABLE");
    this.name = "UploadLockError";
  }
}

export class UploadMutex implements Locker {
  #entries = new Map<string, Entry>();

  constructor(
    private readonly maximumWaiters = 8,
    private readonly timeoutMilliseconds = 30_000,
  ) {}

  newLock(id: string): Lock {
    let acquired = false;
    return {
      lock: async (signal: AbortSignal) => {
        await this.acquire(id, signal);
        acquired = true;
      },
      unlock: async () => {
        if (!acquired) throw new Error("UPLOAD_LOCK_NOT_HELD");
        acquired = false;
        this.release(id);
      },
    };
  }

  async runExclusive<T>(id: string, operation: () => Promise<T>) {
    const lock = this.newLock(id);
    await lock.lock(new AbortController().signal, () => undefined);
    try {
      return await operation();
    } finally {
      await lock.unlock();
    }
  }

  private async acquire(id: string, signal: AbortSignal) {
    const entry = this.#entries.get(id) ?? { locked: false, waiters: [] };
    this.#entries.set(id, entry);
    if (!entry.locked) {
      entry.locked = true;
      return;
    }
    if (entry.waiters.length >= this.maximumWaiters || signal.aborted) {
      throw new UploadLockError();
    }
    await new Promise<void>((resolve, reject) => {
      const onAbort = () => {
        this.removeWaiter(id, waiter);
        reject(new UploadLockError());
      };
      const timer = setTimeout(onAbort, this.timeoutMilliseconds);
      const waiter: Waiter = { resolve, reject, timer, signal, onAbort };
      signal.addEventListener("abort", onAbort, { once: true });
      entry.waiters.push(waiter);
    });
  }

  private release(id: string) {
    const entry = this.#entries.get(id);
    if (!entry?.locked) throw new Error("UPLOAD_LOCK_NOT_HELD");
    const waiter = entry.waiters.shift();
    if (!waiter) {
      this.#entries.delete(id);
      return;
    }
    clearTimeout(waiter.timer);
    waiter.signal.removeEventListener("abort", waiter.onAbort);
    waiter.resolve();
  }

  private removeWaiter(id: string, waiter: Waiter) {
    const entry = this.#entries.get(id);
    if (!entry) return;
    const index = entry.waiters.indexOf(waiter);
    if (index >= 0) entry.waiters.splice(index, 1);
    clearTimeout(waiter.timer);
    waiter.signal.removeEventListener("abort", waiter.onAbort);
  }
}
