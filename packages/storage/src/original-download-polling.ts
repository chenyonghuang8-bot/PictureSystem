type PollDelay = "immediate" | number;

type PollScheduler = (delay: PollDelay) => Promise<void>;

const MAXIMUM_POLL_DELAY_MS = 16;

function defaultScheduler(delay: PollDelay) {
  return new Promise<void>((resolve) => {
    if (delay === "immediate") {
      setImmediate(resolve);
      return;
    }
    // Keep the timer referenced: an awaited download must keep making progress
    // even when no other Node handle happens to be active.
    setTimeout(resolve, delay);
  });
}

/** Internal completion polling; this module is not a package export. */
export async function pollWithBoundedBackoff<T>(
  poll: () => T | null,
  schedule: PollScheduler = defaultScheduler,
): Promise<T> {
  let pendingChecks = 0;
  for (;;) {
    const result = poll();
    if (result !== null) return result;

    const delay =
      pendingChecks === 0
        ? "immediate"
        : Math.min(2 ** (pendingChecks - 1), MAXIMUM_POLL_DELAY_MS);
    pendingChecks += 1;
    await schedule(delay);
  }
}
