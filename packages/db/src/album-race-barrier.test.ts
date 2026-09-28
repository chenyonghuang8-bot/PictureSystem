import { describe, expect, it, vi } from "vitest";
import { albumRaceBarrier } from "./album-race-barrier-test-helper.js";

const event = {
  stage: "MUTATION_APPLIED_BEFORE_COMMIT",
  operation: "NOTE_UPDATE",
  familyId: "9007199254740993",
} as const;

describe("album race latch", () => {
  it("observes an event delivered before wait is called", async () => {
    const latch = albumRaceBarrier(event);
    await latch.hook(event);
    await expect(latch.wait()).resolves.toEqual(event);
  });

  it("ignores other operations/stages and releases an explicitly paused hook", async () => {
    const latch = albumRaceBarrier(event, { pause: true });
    await latch.hook({ ...event, stage: "FAMILY_LOCK_QUERY_DISPATCHED" });
    await latch.hook({ ...event, operation: "TAG_REMOVE" });
    let released = false;
    const pending = Promise.resolve(latch.hook(event)).then(() => {
      expect(released).toBe(true);
    });
    await expect(latch.wait()).resolves.toEqual(event);
    released = true;
    latch.release();
    await pending;
    latch.release();
  });

  it("keeps independent barriers isolated", async () => {
    const first = albumRaceBarrier(event, { pause: true });
    const second = albumRaceBarrier(event, { pause: true });
    const pendingFirst = first.hook(event);
    const pendingSecond = second.hook({ ...event, familyId: "2" });
    expect((await first.wait()).familyId).toBe(event.familyId);
    expect((await second.wait()).familyId).toBe("2");
    first.release();
    second.release();
    await Promise.all([pendingFirst, pendingSecond]);
  });

  it.each(["observation", "release"] as const)(
    "fails a missing %s via watchdog",
    async (kind) => {
      vi.useFakeTimers();
      try {
        const latch = albumRaceBarrier(event, { pause: true, watchdogMs: 100 });
        const pending =
          kind === "observation" ? latch.wait() : latch.hook(event);
        const assertion = expect(pending).rejects.toThrow(
          "ALBUM_RACE_WATCHDOG",
        );
        await vi.advanceTimersByTimeAsync(100);
        await assertion;
      } finally {
        vi.useRealTimers();
      }
    },
  );
});
