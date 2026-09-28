import type {
  AlbumRepositoryTestEvent,
  AlbumRepositoryTestHook,
} from "./album-repository-test-hooks.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

/** Timeout is a failure watchdog, never evidence of ordering or lock waiting. */
async function watchdog<T>(
  pending: Promise<T>,
  milliseconds: number,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      pending,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("ALBUM_RACE_WATCHDOG")),
          milliseconds,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** One-shot, per-test latch. Arm before starting the repository operation. */
export function albumRaceBarrier(
  match: Pick<AlbumRepositoryTestEvent, "stage" | "operation">,
  options: { pause?: boolean; watchdogMs?: number } = {},
) {
  const observed = deferred<AlbumRepositoryTestEvent>();
  const released = deferred<void>();
  const milliseconds = options.watchdogMs ?? 5_000;
  const hook: AlbumRepositoryTestHook = async (event) => {
    if (event.stage !== match.stage || event.operation !== match.operation)
      return;
    observed.resolve(event);
    if (options.pause) await watchdog(released.promise, milliseconds);
  };
  return {
    hook,
    wait: () => watchdog(observed.promise, milliseconds),
    release: () => released.resolve(),
  };
}
