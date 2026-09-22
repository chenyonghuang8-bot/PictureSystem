import { loadApiEnv } from "@family-album/config";
import { createPasswordEngine } from "@family-album/auth";
import {
  acquireCheckedConnection,
  assertMigrationReadiness,
  createDatabase,
  MySqlAuthRepository,
  MySqlPhase1CRepository,
  MySqlAlbumRepository,
  MySqlUploadRepository,
} from "@family-album/db";
import { resolve } from "node:path";
import {
  CapacityGate,
  probeStorageCapability,
  type StorageCapability,
} from "@family-album/storage";
import { createApp } from "./app.js";
import { AuthService } from "./auth/service.js";
import { Phase1CService } from "./phase1c/service.js";
import { AlbumService } from "./albums/service.js";
import { UploadService } from "./uploads/service.js";
import type { ReconciliationResult } from "./uploads/recovery.js";
import { UploadMutex } from "./uploads/mutex.js";
import { assessStorageStartup } from "./uploads/startup.js";

const env = loadApiEnv();
const database = createDatabase(env.DATABASE_URL);
const passwords = createPasswordEngine();
const authService = await AuthService.create(
  new MySqlAuthRepository(database.pool),
  passwords,
);
const phase1cService = new Phase1CService(
  new MySqlPhase1CRepository(database.pool),
  passwords,
  env.TRUSTED_WEB_ORIGINS[0]!,
);
const albumService = new AlbumService(new MySqlAlbumRepository(database.pool));
let storageCapability: StorageCapability = {
  state: "UNAVAILABLE",
  reason: "STORAGE_NOT_CONFIGURED",
};
let sharedCapacityGate: CapacityGate | undefined;
const uploadRepository = new MySqlUploadRepository(database.pool);
const uploadMutex = new UploadMutex();
let startupRecoveryReport: ReconciliationResult | null = null;
if (env.DEV_STORAGE_MARKER_ID) {
  const connection = await acquireCheckedConnection(database.pool);
  try {
    await assertMigrationReadiness(connection);
    storageCapability = probeStorageCapability({
      mediaRoot: resolve(process.cwd(), env.DEV_MEDIA_ROOT),
      initialize: false,
      expectedMarkerId: env.DEV_STORAGE_MARKER_ID,
    });
    if (storageCapability.state === "READ_WRITE") {
      const assessed = await assessStorageStartup(
        uploadRepository,
        storageCapability,
        uploadMutex,
      );
      storageCapability = assessed.capability;
      startupRecoveryReport = assessed.report;
    }
    if (storageCapability.state === "READ_WRITE") {
      try {
        sharedCapacityGate = CapacityGate.open({
          mediaRoot: storageCapability.root.canonicalPath,
          expectedMarkerId: storageCapability.root.markerId,
        });
      } catch {
        storageCapability = {
          state: "READ_ONLY",
          root: storageCapability.root,
          reason: "CAPACITY_GATE_UNAVAILABLE",
        };
      }
    }
  } finally {
    connection.release();
  }
}
const uploadService = new UploadService(
  uploadRepository,
  storageCapability,
  sharedCapacityGate,
);
const app = createApp({
  authService,
  phase1cService,
  albumService,
  uploadService,
  publicApiOrigin: env.API_PUBLIC_ORIGIN,
  trustedOrigins: new Set(env.TRUSTED_WEB_ORIGINS),
  trustedProxies: env.TRUSTED_PROXY_CIDRS,
  uploadMutex,
});
if (startupRecoveryReport) {
  const safeFields = {
    event: "recovery_action",
    scope: "startup",
    scannedUploads: startupRecoveryReport.scannedUploads,
    expiredTransitioned: startupRecoveryReport.expiredTransitioned,
    stagingCleaned: startupRecoveryReport.stagingCleaned,
    orphanStagingCandidates: startupRecoveryReport.orphanStagingCandidates,
    orphanFinalCandidates: startupRecoveryReport.orphanFinalCandidates,
    integrityMismatches: startupRecoveryReport.integrityMismatches,
    skippedUnsafeEntries: startupRecoveryReport.skippedUnsafeEntries,
    capability: storageCapability.state,
  };
  if (storageCapability.state === "READ_WRITE")
    app.log.info(safeFields, "storage reconciliation assessed");
  else app.log.warn(safeFields, "storage reconciliation failed closed");
}

app.addHook("onClose", async () => {
  if (storageCapability.state === "READ_WRITE") storageCapability.root.close();
  await database.pool.end();
});

try {
  await app.listen({ host: env.API_HOST, port: env.API_PORT });
} catch (error) {
  app.log.error({ err: error }, "API failed to start");
  process.exitCode = 1;
}
