import { describe, expect, it, vi } from "vitest";
import type { StorageRoot } from "@family-album/storage";
import { storageSafetyBudget } from "@family-album/db";
import { assertStorageOwnerHealth } from "./storage-owner-health.js";
function fixture(totalBytes = 100n * 1024n ** 3n) {
  const min =
    totalBytes / 10n > storageSafetyBudget.minFreeReserve
      ? totalBytes / 10n
      : storageSafetyBudget.minFreeReserve;
  const root = {
    assertIdentity: vi.fn(),
    assertCoordinationNamespace: vi.fn(),
    assertWritableMount: vi.fn(),
    capacity: vi.fn(() => ({
      totalBytes,
      availableBytes: min + storageSafetyBudget.scratchReserve + 50n,
    })),
  };
  const repository = {
    storageObservation: vi.fn(async () => ({
      reservedFutureBytes: 30n,
      unsettledBytes: 20n,
      unsettledPurges: 0n,
    })),
  };
  return {
    root,
    repository,
    run: () =>
      assertStorageOwnerHealth(root as unknown as StorageRoot, repository),
  };
}
describe("read-only owner health", () => {
  it.each([100n * 1024n ** 3n, 1000n * 1024n ** 3n])(
    "uses the existing max(minimum, ten percent) budget for %s bytes",
    async (total) => {
      const { root, repository, run } = fixture(total);
      await run();
      expect(repository.storageObservation).toHaveBeenCalledOnce();
      expect(root.assertIdentity).toHaveBeenCalledTimes(2);
      expect(root.assertCoordinationNamespace).toHaveBeenCalledTimes(2);
    },
  );
  it("includes future upload reservations and unsettled derived/purge charges", async () => {
    const { repository, run } = fixture();
    repository.storageObservation.mockResolvedValue({
      reservedFutureBytes: 31n,
      unsettledBytes: 20n,
      unsettledPurges: 1n,
    });
    await expect(run()).rejects.toThrow("STORAGE_CAPACITY_LOW");
  });
  it("a failed authoritative observation is unavailable, not an empty zero inventory", async () => {
    const { repository, run } = fixture();
    repository.storageObservation.mockRejectedValue(Error("DB_UNAVAILABLE"));
    await expect(run()).rejects.toThrow("DB_UNAVAILABLE");
  });
  it("rechecks the root after the DB observation to reject namespace replacement", async () => {
    const { root, run } = fixture();
    root.assertCoordinationNamespace
      .mockImplementationOnce(() => {})
      .mockImplementationOnce(() => {
        throw Error("ROOT_REPLACED");
      });
    await expect(run()).rejects.toThrow("ROOT_REPLACED");
  });
});
