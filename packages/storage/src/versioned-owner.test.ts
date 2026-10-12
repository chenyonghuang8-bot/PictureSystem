import { describe, expect, it, vi } from "vitest";
import { VersionedOwner } from "./versioned-owner.js";
import type { ControlRecoveryPermit } from "./control-coordinator.js";

function latch<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
// Explicit unit permit; native coordinator tests separately prove it cannot be
// minted by an HTTP caller or by the latch mutex.
function permit() {
  return {
    run: vi.fn(async (_action: string, operation: () => Promise<unknown>) =>
      operation(),
    ),
  } as unknown as ControlRecoveryPermit;
}
describe("versioned unique owner lifecycle", () => {
  it("drains actual read/write callbacks before close then opens a new generation", async () => {
    const release = latch<void>(),
      entered = latch<void>();
    const sequence: string[] = [];
    const owner = new VersionedOwner<string>("old", async (v) => {
      sequence.push(`close:${v}`);
    });
    const read = owner.withValue(async (v) => {
      expect(v).toBe("old");
      entered.resolve();
      await release.promise;
      sequence.push("settled");
    });
    await entered.promise;
    const p = permit();
    const replacement = owner.replace(p, async () => {
      sequence.push("open:new");
      return "new";
    });
    expect(owner.isChanging()).toBe(true);
    await expect(owner.withValue(async () => {})).rejects.toThrow(
      "OWNER_NOT_READY",
    );
    expect(sequence).toEqual([]);
    release.resolve();
    await read;
    expect(await replacement).toBe("READY");
    expect(sequence).toEqual(["settled", "close:old", "open:new"]);
    expect(p.run).toHaveBeenCalledWith("STARTUP_ASSESS", expect.any(Function));
    expect(owner.generation()).toBe("2");
    expect(await owner.withValue(async (v) => v)).toBe("new");
    await owner.close();
  });
  it("a drain deadline keeps the old live callback and does not open a second writer", async () => {
    const release = latch<void>(),
      entered = latch<void>();
    const close = vi.fn(),
      create = vi.fn(async () => "new");
    const owner = new VersionedOwner<string>("old", close);
    const read = owner.withValue(async () => {
      entered.resolve();
      await release.promise;
    });
    await entered.promise;
    expect(await owner.replace(permit(), create, 0)).toBe("NOT_READY");
    expect(close).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
    expect(owner.generation()).toBe("1");
    await expect(owner.close()).rejects.toThrow("OWNER_DRAIN_REQUIRED");
    release.resolve();
    await read;
    await owner.close();
  });
  it("a partially failed old close makes both old and new resource unreachable", async () => {
    const create = vi.fn(async () => "new");
    const owner = new VersionedOwner<string>("old", async () => {
      throw Error("CLOSE_UNCERTAIN");
    });
    await expect(owner.replace(permit(), create)).rejects.toThrow(
      "CLOSE_UNCERTAIN",
    );
    expect(create).not.toHaveBeenCalled();
    expect(owner.isAvailable()).toBe(false);
    await expect(owner.withValue(async () => {})).rejects.toThrow(
      "OWNER_NOT_READY",
    );
  });
  it("a failed fresh open never restores poisoned old handles; a later fenced attempt can recover", async () => {
    const close = vi.fn();
    const owner = new VersionedOwner<string>("old", close);
    await expect(
      owner.replace(permit(), async () => {
        throw Error("OWNER_BUSY");
      }),
    ).rejects.toThrow("OWNER_BUSY");
    expect(owner.isAvailable()).toBe(false);
    expect(owner.generation()).toBe("1");
    expect(await owner.replace(permit(), async () => "fresh")).toBe("READY");
    expect(close).toHaveBeenCalledTimes(1);
    expect(owner.generation()).toBe("2");
    await owner.close();
  });
  it("a rejected callback still holds its lease until settlement and then releases it", async () => {
    const owner = new VersionedOwner<string>("old", vi.fn());
    await expect(
      owner.withValue(async () => {
        throw Error("READ_FAILED");
      }),
    ).rejects.toThrow("READ_FAILED");
    expect(await owner.replace(permit(), async () => "new", 0)).toBe("READY");
    await owner.close();
  });
  it("overlapping replacements cannot create competing owners", async () => {
    const opened = latch<string>();
    const owner = new VersionedOwner<string>("old", vi.fn());
    const first = owner.replace(permit(), () => opened.promise);
    const second = vi.fn(async () => "second");
    await expect(owner.replace(permit(), second)).rejects.toThrow(
      "OWNER_NOT_READY",
    );
    expect(second).not.toHaveBeenCalled();
    opened.resolve("fresh");
    await first;
    await owner.close();
  });
});
