import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import type { StorageRoot } from "./index.js";
import type { DerivedStore } from "./derived-store.js";
import type { ReadGuard } from "./phase7-coordination.js";
import { purgeBindings } from "./purge-bindings.js";
export type PurgeFile = {
  id: string;
  familyId: string;
  intentId: string;
  fileKind: "ORIGINAL" | "DERIVED";
  storageId: string | null;
  mediaId: string | null;
  sha256Hex: string;
  byteSize: string;
  markerId: string;
  device: string;
  generation: string | null;
  recipeId: number | null;
  kind: "THUMBNAIL" | "PREVIEW" | null;
  jobId: string | null;
  epoch: string | null;
  stage:
    | "CATALOGUED"
    | "QUARANTINED"
    | "UNLINK_ARMED"
    | "REMOVED"
    | "ABSENT_DERIVED";
  slotHex: string | null;
  quarantineDevice: string | null;
  quarantineInode: string | null;
};

type PurgeFilesBinding = {
  purgeFileExact(
    root: object,
    store: object,
    life: object,
    read: object,
    input: object,
  ): { stage: PurgeFile["stage"]; device: string; inode: string };
};
const require = createRequire(import.meta.url);
const spent = new WeakSet<object>();
export class PurgeFilesNative {
  constructor(
    private readonly root: StorageRoot,
    private readonly store: DerivedStore,
    private readonly read: ReadGuard,
    private readonly bindingForTest?: PurgeFilesBinding,
  ) {
    if (bindingForTest && process.env.NODE_ENV !== "test")
      throw new Error("PURGE_TEST_ONLY");
  }
  execute(
    file: PurgeFile,
    action: "QUARANTINE" | "UNLINK" | "VERIFY",
    permit: {
      originalSha256Hex: string;
      originalByteSize: string;
      permitDeadlineMs: number;
    },
  ) {
    if (spent.has(permit)) throw new Error("PURGE_PERMIT_CONSUMED");
    spent.add(permit);
    const native =
      this.bindingForTest ??
      (require(
        join(
          dirname(require.resolve("@family-album/storage")),
          "../build/storage_native.node",
        ),
      ) as PurgeFilesBinding);
    const handles = purgeBindings(this.root, this.store);
    try {
      return this.read.withNativeExclusive((life, read) =>
        native.purgeFileExact(handles.original, handles.derived, life, read, {
          ...file,
          ...permit,
          action,
        }),
      );
    } catch {
      throw new Error("PURGE_FILESYSTEM_UNCERTAIN");
    }
  }
}

export function assertPurgeOwners(root: StorageRoot, store: DerivedStore) {
  const native = require(
    join(
      dirname(require.resolve("@family-album/storage")),
      "../build/storage_native.node",
    ),
  ) as { purgeOwners(root: object, store: object): void };
  const handles = purgeBindings(root, store);
  try {
    native.purgeOwners(handles.original, handles.derived);
  } catch {
    throw new Error("PURGE_WRITER_REQUIRED");
  }
}
