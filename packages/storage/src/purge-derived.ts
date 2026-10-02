import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import type { StorageRoot } from "./index.js";
import type { DerivedStore } from "./derived-store.js";
import type { ReadGuard } from "./phase7-coordination.js";
import { purgeBindings } from "./purge-bindings.js";

// Internal adapter: no package export and no path/descriptor input. The worker
// obtains each one-shot destructive permit from its current SQL lease fence.
export type PurgeDerivedIdentity = {
  familyId: string;
  mediaId: string;
  generation: string;
  jobId: string;
  epoch: string;
  kind: "THUMBNAIL" | "PREVIEW";
};
export type PurgeDerivedFact = {
  fileClass: "ABSENT" | "REGULAR";
  byteSize: string;
  device: string;
  inode: string;
  mode: string;
  nlink: string;
  sha256Hex: string;
};
type Binding = {
  purgeMonotonicClock(): number;
  purgeDerivedInventory(
    root: object,
    store: object,
    life: object,
    read: object,
    input: { familyId: string; mediaId: string; jobs: string[] },
  ): {
    name: "TEMP" | "FINAL";
    jobId: string;
    epoch: string;
    generation: string;
    kind: string;
  }[];
  purgeDerivedExact(
    root: object,
    store: object,
    life: object,
    read: object,
    input: PurgeDerivedIdentity & { action: string } & Record<string, unknown>,
  ): PurgeDerivedFact;
};
const require = createRequire(import.meta.url);
const usedPermits = new WeakSet<object>();
function binding(): Binding {
  return require(
    join(
      dirname(require.resolve("@family-album/storage")),
      "../build/storage_native.node",
    ),
  ) as Binding;
}
export class PurgeDerivedNative {
  constructor(
    private readonly root: StorageRoot,
    private readonly store: DerivedStore,
    private readonly read: ReadGuard,
    private readonly bindingForTest?: Binding,
  ) {
    if (bindingForTest && process.env.NODE_ENV !== "test")
      throw new Error("PURGE_TEST_ONLY");
  }
  private native() {
    return this.bindingForTest ?? binding();
  }
  monotonicClock() {
    return this.native().purgeMonotonicClock();
  }
  inventory(familyId: string, mediaId: string, jobs: string[]) {
    const handles = purgeBindings(this.root, this.store);
    try {
      return this.read.withNativeExclusive((life, read) =>
        this.native().purgeDerivedInventory(
          handles.original,
          handles.derived,
          life,
          read,
          { familyId, mediaId, jobs },
        ),
      );
    } catch (error) {
      throw new Error("PURGE_INVENTORY_INCOMPLETE", { cause: error });
    }
  }
  private call(
    identity: PurgeDerivedIdentity,
    action: string,
    extra: Record<string, unknown> = {},
  ) {
    const handles = purgeBindings(this.root, this.store);
    try {
      return this.read.withNativeExclusive((life, read) =>
        this.native().purgeDerivedExact(
          handles.original,
          handles.derived,
          life,
          read,
          {
            ...identity,
            ...extra,
            action,
          },
        ),
      );
    } catch (error) {
      const code =
        error && typeof error === "object" && "code" in error
          ? String(error.code)
          : "";
      throw new Error(
        /^PURGE_[A-Z_]+$/u.test(code) ? code : "PURGE_FILESYSTEM_UNCERTAIN",
        { cause: error },
      );
    }
  }
  inspect(identity: PurgeDerivedIdentity) {
    return {
      temp: this.call(identity, "TEMP_INSPECT"),
      final: this.call(identity, "FINAL_INSPECT"),
    };
  }
  remove(
    identity: PurgeDerivedIdentity,
    name: "TEMP" | "FINAL",
    fact: PurgeDerivedFact,
    permit: {
      originalSha256Hex: string;
      originalByteSize: string;
      permitDeadlineMs: number;
    },
    pairedFinal?: PurgeDerivedFact,
  ) {
    if (usedPermits.has(permit)) throw new Error("PURGE_PERMIT_CONSUMED");
    usedPermits.add(permit);
    return this.call(identity, `${name}_REMOVE`, {
      ...fact,
      ...permit,
      ...(pairedFinal
        ? {
            pairedSha256Hex: pairedFinal.sha256Hex,
            pairedByteSize: pairedFinal.byteSize,
            pairedInode: pairedFinal.inode,
            pairedDevice: pairedFinal.device,
          }
        : {}),
    });
  }
}

export type PurgeNormalizationAsset = PurgeDerivedIdentity & {
  state: string;
  cleanedAt: Date | null;
  reservedBytes: bigint;
  sha256Hex: string | null;
  byteSize: bigint | null;
};
export function planPurgeDerivedNormalization(
  asset: PurgeNormalizationAsset,
  facts: { temp: PurgeDerivedFact; final: PurgeDerivedFact },
): readonly ("TEMP" | "FINAL")[] | "READY" {
  const { temp, final } = facts;
  const tempPresent = temp.fileClass === "REGULAR";
  const finalPresent = final.fileClass === "REGULAR";
  if (
    !["ABSENT", "REGULAR"].includes(temp.fileClass) ||
    !["ABSENT", "REGULAR"].includes(final.fileClass)
  )
    throw new Error("PURGE_FILESYSTEM_UNCERTAIN");
  if (asset.state === "READY") {
    if (asset.cleanedAt || tempPresent) throw new Error("PURGE_READY_RESIDUE");
    if (!asset.sha256Hex || asset.byteSize === null)
      throw new Error("PURGE_PAYLOAD_REQUIRED");
  } else if (
    !["RESERVED", "PUBLISHING", "FAILED", "MISSING"].includes(asset.state)
  ) {
    throw new Error("PURGE_UNKNOWN_STATE");
  }
  if (asset.cleanedAt && (tempPresent || finalPresent))
    throw new Error("PURGE_CLEANED_RESIDUE");
  for (const fact of [temp, final]) {
    if (fact.fileClass === "ABSENT") continue;
    if (
      fact.nlink !== "1" ||
      !/^[0-9a-f]{64}$/u.test(fact.sha256Hex) ||
      BigInt(fact.byteSize) > asset.reservedBytes ||
      (fact.mode !== "400" && (fact !== temp || fact.mode !== "600")) ||
      (fact.mode === "400" && BigInt(fact.byteSize) <= 0n)
    )
      throw new Error("PURGE_FILE_IDENTITY");
    if (
      (asset.sha256Hex !== null && asset.sha256Hex !== fact.sha256Hex) ||
      (asset.byteSize !== null && asset.byteSize !== BigInt(fact.byteSize))
    )
      throw new Error("PURGE_PAYLOAD_CONFLICT");
    if (
      asset.state === "PUBLISHING" &&
      (!asset.sha256Hex || asset.byteSize === null || fact.mode !== "400")
    )
      throw new Error("PURGE_PAYLOAD_REQUIRED");
  }
  if (asset.state === "READY") return "READY";
  if (
    tempPresent &&
    finalPresent &&
    (temp.mode !== "400" ||
      temp.sha256Hex !== final.sha256Hex ||
      temp.byteSize !== final.byteSize)
  )
    throw new Error("PURGE_DUAL_CONFLICT");
  return [
    ...(tempPresent ? ["TEMP" as const] : []),
    ...(finalPresent ? ["FINAL" as const] : []),
  ];
}
