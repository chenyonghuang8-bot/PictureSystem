import { storageSafetyBudget } from "@family-album/db";
import type { MySqlSystemControlRepository } from "@family-album/db";
import type {
  StorageRoot,
  OriginalReader,
  CapacityGate,
} from "@family-album/storage";

/** Read-only native identities + existing capacity budget. No DB row locks,
 * reservations, probe writes, media reads, or competing writer are created. */
export async function assertStorageOwnerHealth(
  root: StorageRoot,
  repository: Pick<MySqlSystemControlRepository, "storageObservation">,
  options: { reader?: OriginalReader; gate?: CapacityGate } = {},
) {
  root.assertIdentity();
  root.assertCoordinationNamespace();
  root.assertWritableMount();
  options.reader?.assertIdentity();
  const capacity = options.gate
    ? await options.gate.withLock(async (snapshot) => snapshot)
    : root.capacity();
  const inventory = await repository.storageObservation();
  const margin =
    capacity.totalBytes / 10n > storageSafetyBudget.minFreeReserve
      ? capacity.totalBytes / 10n
      : storageSafetyBudget.minFreeReserve;
  if (
    capacity.availableBytes <
    margin +
      storageSafetyBudget.scratchReserve +
      inventory.reservedFutureBytes +
      inventory.unsettledBytes
  )
    throw Error("STORAGE_CAPACITY_LOW");
  // Close a namespace replacement between the native check and DB observation.
  root.assertIdentity();
  root.assertCoordinationNamespace();
  root.assertWritableMount();
  options.reader?.assertIdentity();
  return capacity;
}
