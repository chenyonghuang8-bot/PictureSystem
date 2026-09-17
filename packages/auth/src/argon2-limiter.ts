export class Argon2CapacityError extends Error {
  constructor() {
    super("Password processing capacity is temporarily unavailable.");
    this.name = "Argon2CapacityError";
  }
}

type QueueEntry<T> = {
  task: () => Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
  timer: NodeJS.Timeout;
};

export class Argon2Limiter {
  private active = 0;
  private readonly queue: QueueEntry<unknown>[] = [];

  constructor(
    readonly maxConcurrent = 2,
    readonly maxQueue = 10,
    readonly waitTimeoutMs = 5_000,
  ) {
    if (maxConcurrent < 1 || maxQueue < 0 || waitTimeoutMs < 1) {
      throw new Error("Invalid Argon2 limiter configuration.");
    }
  }

  run<T>(task: () => Promise<T>): Promise<T> {
    if (this.active < this.maxConcurrent) return this.start(task);
    if (this.queue.length >= this.maxQueue) {
      return Promise.reject(new Argon2CapacityError());
    }

    return new Promise<T>((resolve, reject) => {
      const entry: QueueEntry<T> = {
        task,
        resolve,
        reject,
        timer: setTimeout(() => {
          const index = this.queue.indexOf(entry as QueueEntry<unknown>);
          if (index >= 0) this.queue.splice(index, 1);
          reject(new Argon2CapacityError());
        }, this.waitTimeoutMs),
      };
      this.queue.push(entry as QueueEntry<unknown>);
    });
  }

  private async start<T>(task: () => Promise<T>): Promise<T> {
    this.active += 1;
    try {
      return await task();
    } finally {
      this.active -= 1;
      this.drain();
    }
  }

  private drain() {
    while (this.active < this.maxConcurrent) {
      const entry = this.queue.shift();
      if (!entry) return;
      clearTimeout(entry.timer);
      void this.start(entry.task).then(entry.resolve, entry.reject);
    }
  }
}
