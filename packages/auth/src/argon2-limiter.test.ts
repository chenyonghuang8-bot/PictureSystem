import { describe, expect, it } from "vitest";

import { Argon2CapacityError, Argon2Limiter } from "./argon2-limiter.js";

describe("Argon2Limiter", () => {
  it("bounds concurrent work and its queue", async () => {
    const limiter = new Argon2Limiter(2, 1, 1_000);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let active = 0;
    let peak = 0;
    const work = () =>
      limiter.run(async () => {
        active += 1;
        peak = Math.max(peak, active);
        await gate;
        active -= 1;
      });

    const first = work();
    const second = work();
    const queued = work();
    await expect(work()).rejects.toBeInstanceOf(Argon2CapacityError);
    release();
    await Promise.all([first, second, queued]);
    expect(peak).toBe(2);
  });

  it("times out queued work without releasing the active operation", async () => {
    const limiter = new Argon2Limiter(1, 1, 5);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const active = limiter.run(() => gate);
    await expect(limiter.run(async () => undefined)).rejects.toBeInstanceOf(
      Argon2CapacityError,
    );
    release();
    await active;
  });
});
