import { describe, expect, it, vi } from "vitest";
import { VersionedOwner } from "@family-album/storage";
import type { ControlRecoveryPermit } from "@family-album/storage";
import { borrowedService } from "./borrowed-service.js";
class Service {
  #value: string;
  constructor(value: string) {
    this.#value = value;
  }
  readonly max = 4n;
  async read(done?: Promise<void>) {
    await done;
    return this.#value;
  }
}
const permit = {
  run: async (_action: string, f: () => Promise<unknown>) => f(),
} as unknown as ControlRecoveryPermit;
describe("borrowed service generation", () => {
  it("keeps the original private-field receiver and picks the current generation on each request", async () => {
    const owner = new VersionedOwner({ service: new Service("old") }, vi.fn());
    const service = borrowedService<{ service: Service }, Service>(
      owner,
      (r) => r.service,
      ["read"],
      {
        max: 4n,
      },
    );
    expect(await service.read()).toBe("old");
    await owner.replace(permit, async () => ({
      service: new Service("fresh"),
    }));
    expect(await service.read()).toBe("fresh");
    expect(service.max).toBe(4n);
    await owner.close();
  });
  it("an in-flight async service call prevents owner close even after response setup", async () => {
    const close = vi.fn();
    const owner = new VersionedOwner({ service: new Service("old") }, close);
    const service = borrowedService<{ service: Service }, Service>(
      owner,
      (r) => r.service,
      ["read"],
    );
    let release!: () => void;
    const read = service.read(
      new Promise<void>((r) => {
        release = r;
      }),
    );
    expect(
      await owner.replace(
        permit,
        async () => ({ service: new Service("fresh") }),
        0,
      ),
    ).toBe("NOT_READY");
    expect(close).not.toHaveBeenCalled();
    release();
    expect(await read).toBe("old");
    await owner.close();
  });
});
