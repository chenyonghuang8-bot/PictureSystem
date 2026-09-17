import type { MySqlUploadRepository } from "@family-album/db";
import type { StorageCapability } from "@family-album/storage";

import type { UploadMutex } from "./mutex.js";
import { StorageReconciler, type ReconciliationResult } from "./recovery.js";

export function startupRecoveryComplete(report: ReconciliationResult) {
  return (
    report.errors === 0 &&
    !report.truncated &&
    report.skippedUnsafeEntries === 0 &&
    report.orphanFinalCandidates === 0 &&
    report.orphanStagingCandidates === 0 &&
    report.integrityMismatches === 0 &&
    report.dbMissingFinal === 0
  );
}

// This is the same gate used by the actual API before it opens upload routes.
// A synthetic familyScope is available only to integration fixtures; the API
// always invokes the full global scope.
export async function assessStorageStartup(
  repository: MySqlUploadRepository,
  capability: StorageCapability,
  mutex: UploadMutex,
  options: { familyScope?: string; maxCandidates?: number } = {},
): Promise<{
  capability: StorageCapability;
  report: ReconciliationResult | null;
}> {
  if (capability.state !== "READ_WRITE") return { capability, report: null };
  let report: ReconciliationResult | null = null;
  try {
    report = await new StorageReconciler(repository, capability, mutex).run({
      mode: "recover",
      scope: "startup",
      maxCandidates: options.maxCandidates ?? 20_000,
      ...(options.familyScope ? { familyScope: options.familyScope } : {}),
    });
    if (!startupRecoveryComplete(report))
      throw new Error("STORAGE_STARTUP_RECOVERY_INCOMPLETE");
    return { capability, report };
  } catch {
    capability.root.close();
    return {
      capability: {
        state: "UNAVAILABLE",
        reason: "STORAGE_STARTUP_RECOVERY_INCOMPLETE",
      },
      report,
    };
  }
}
