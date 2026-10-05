import {
  loadLocationProjector,
  type LocationProjector,
} from "@family-album/media";
import { loadApiEnv } from "@family-album/config";
import { createPasswordEngine } from "@family-album/auth";
import {
  acquireCheckedConnection,
  assertMigrationReadiness,
  createDatabase,
  MySqlAuthRepository,
  MySqlPhase1CRepository,
  MySqlAlbumRepository,
  MySqlDerivedReadRepository,
  MySqlShareRepository,
  MySqlUploadRepository,
  MySqlTrashRepository,
  MySqlUploadPipelineRepository,
  MySqlMediaRepository,
  MySqlJobRepository,
} from "@family-album/db";
import { resolve } from "node:path";
import { coordinatedDerivedReader } from "./derived-serving/reader.js";
import {
  CapacityGate,
  DerivedStore,
  OriginalReader,
  probeStorageCapability,
  StorageSafetyError,
  type StorageCapability,
} from "@family-album/storage";
import { createApp } from "./app.js";
import { AuthService } from "./auth/service.js";
import { Phase1CService } from "./phase1c/service.js";
import { AlbumService } from "./albums/service.js";
import { PublicShareService } from "./shares/public-service.js";
import { ShareService } from "./shares/service.js";
import { UploadService } from "./uploads/service.js";
import { TrashService } from "./trash/service.js";
import type { ReconciliationResult } from "./uploads/recovery.js";
import { UploadMutex } from "./uploads/mutex.js";
import { assessStorageStartup } from "./uploads/startup.js";
import { DerivedReadService } from "./derived-serving/service.js";
import {
  OriginalDownloadService,
  type OriginalDownloadReader,
} from "./original-download/service.js";
import {
  PreviewDownloadService,
  type PreviewDownloadReader,
} from "./preview-download/service.js";

import { UploadPipelineReconciler } from "./uploads/pipeline-reconciler.js";
import { ImageDerivativeDriver } from "../../worker/src/image-derivative-driver.js";

async function main() {
  const env = loadApiEnv();
  const database = createDatabase(env.DATABASE_URL);
  let storageCapability: StorageCapability = {
    state: "UNAVAILABLE",
    reason: "STORAGE_NOT_CONFIGURED",
  };
  let sharedCapacityGate: CapacityGate | undefined;
  let originalReader: OriginalReader | undefined;
  let derivedStore: DerivedStore | undefined;
  let reconciler: UploadPipelineReconciler | undefined;
  let derivative: ImageDerivativeDriver | undefined;
  let app: ReturnType<typeof createApp> | undefined;
  let cleanupPromise: Promise<void> | undefined;
  const requestStop = () => {
    reconciler?.requestStop();
    derivative?.requestStop();
  };
  const cleanup = () =>
    (cleanupPromise ??= (async () => {
      requestStop();
      const results = await Promise.allSettled([
        reconciler?.drain(),
        derivative?.drain(),
      ]);
      let failed = results.some((r) => r.status === "rejected");
      for (const resource of [
        derivedStore,
        originalReader,
        sharedCapacityGate,
        storageCapability.state !== "UNAVAILABLE"
          ? storageCapability.root
          : undefined,
      ]) {
        try {
          resource?.close();
        } catch {
          failed = true;
        }
      }
      try {
        await database.pool.end();
      } catch {
        failed = true;
      }
      if (failed) throw new Error("PIPELINE_SHUTDOWN_FAILED");
    })());
  try {
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
    let locationProjector: LocationProjector | undefined;
    if (process.env.LOCATION_DATA_DIR) {
      try {
        locationProjector = loadLocationProjector(
          resolve(process.env.LOCATION_DATA_DIR),
        );
      } catch {
        console.error(
          '{"event":"location_capability_disabled","category":"DATASET_INVALID"}',
        );
      }
    }
    const albumRepository = new MySqlAlbumRepository(
      database.pool,
      locationProjector ? { locationProjector } : undefined,
    );
    const albumService = new AlbumService(albumRepository);
    const shareRepository = new MySqlShareRepository(
      database.pool,
      albumRepository,
    );
    const shareService = new ShareService(shareRepository);
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
    const derivedReads = new MySqlDerivedReadRepository(database.pool);
    const derivedReader = coordinatedDerivedReader(
      storageCapability,
      sharedCapacityGate,
    );
    const derivedService = new DerivedReadService(derivedReads, derivedReader);
    if (storageCapability.state !== "UNAVAILABLE") {
      try {
        originalReader = OriginalReader.open({
          mediaRoot: storageCapability.root.canonicalPath,
          expectedMarkerId: storageCapability.root.markerId,
        });
      } catch {
        originalReader = undefined;
      }
    }
    const unavailableOriginalReader: OriginalDownloadReader = {
      withVerifiedDownload: async () => {
        throw new StorageSafetyError("ORIGINAL_READER_UNAVAILABLE");
      },
    };
    const originalDownloadService = new OriginalDownloadService(
      albumRepository,
      originalReader ?? unavailableOriginalReader,
    );
    const previewDownloadReader: PreviewDownloadReader = derivedReader;
    const previewDownloadService = new PreviewDownloadService(
      albumRepository,
      previewDownloadReader,
    );
    const publicShareService = new PublicShareService(
      shareService,
      shareRepository,
      derivedReads,
      derivedReader,
    );
    const uploadService = new UploadService(
      uploadRepository,
      storageCapability,
      sharedCapacityGate,
    );
    app = createApp({
      trashService: new TrashService(
        new MySqlTrashRepository(database.pool),
        storageCapability,
      ),
      authService,
      phase1cService,
      albumService,
      shareService,
      publicShareService,
      uploadService,
      derivedService,
      originalDownloadService,
      previewDownloadService,
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

    const enabled = process.env.DEV_MEDIA_PIPELINE_ENABLED;
    if (enabled !== undefined && enabled !== "0" && enabled !== "1")
      throw new Error("PIPELINE_ENABLE_INVALID");
    if (enabled === "1") {
      const target = new URL(env.DATABASE_URL);
      if (
        env.APP_ENV !== "dev" ||
        target.pathname !== "/family_album_dev" ||
        !env.DEV_STORAGE_MARKER_ID ||
        decodeURIComponent(target.username).toLowerCase() === "root" ||
        storageCapability.state !== "READ_WRITE" ||
        !sharedCapacityGate ||
        !originalReader
      )
        throw new Error("PIPELINE_DEV_STARTUP_REFUSED");
      const c = await acquireCheckedConnection(database.pool);
      try {
        await assertMigrationReadiness(c);
        const [rows] = await c.query(
          "SELECT DATABASE() db,CURRENT_USER() account",
        );
        const row = (rows as { db: string; account: string }[])[0];
        if (
          row?.db !== "family_album_dev" ||
          row.account.split("@")[0]?.toLowerCase() === "root"
        )
          throw new Error("PIPELINE_DEV_DATABASE_REQUIRED");
      } finally {
        c.release();
      }
      storageCapability.root.assertCoordinationNamespace();
      derivedStore = DerivedStore.open(storageCapability);
      reconciler = new UploadPipelineReconciler(
        {
          repository: new MySqlUploadPipelineRepository(database.pool),
          media: new MySqlMediaRepository(database.pool),
          jobs: new MySqlJobRepository(database.pool),
          acquire: UploadPipelineReconciler.acquire(storageCapability.root),
        },
        (counts) =>
          app!.log.info(
            { event: "upload_pipeline_round", counts },
            "pipeline round assessed",
          ),
      );
      derivative = new ImageDerivativeDriver(
        database.pool,
        {
          capability: storageCapability,
          gate: sharedCapacityGate,
          store: derivedStore,
        },
        originalReader,
      );
    }
    app.addHook("onClose", cleanup);
    let shuttingDown: Promise<void> | undefined;
    app.addHook("onResponse", async () => {
      if (shuttingDown) {
        // A keep-alive connection that was active when close began can become
        // idle after the initial server-close sweep. Close only idle sockets;
        // active requests and native/SQL operations retain their drain contract.
        setImmediate(() => app!.server.closeIdleConnections());
      }
    });
    const shutdown = () =>
      (shuttingDown ??= (async () => {
        requestStop();
        await app!.close();
      })());
    const signal = () => {
      void shutdown().catch(() => {
        process.exitCode = 1;
        console.error(
          '{"event":"pipeline_shutdown_failed","category":"CLEANUP_FAILED"}',
        );
      });
    };
    process.once("SIGINT", signal);
    process.once("SIGTERM", signal);
    app.addHook("onClose", async () => {
      process.removeListener("SIGINT", signal);
      process.removeListener("SIGTERM", signal);
    });
    await app.listen({ host: env.API_HOST, port: env.API_PORT });
    const fatal = () => {
      process.exitCode = 1;
      app!.log.error(
        {
          event: "media_pipeline_stopped",
          category: "EXECUTION_REFUSED_OR_UNKNOWN",
        },
        "pipeline stopped",
      );
      signal();
    };
    // Observe both promises immediately; a fatal operation stops selection in both
    // loops and closes the owner only after requests/current operations drain.
    void reconciler?.start().catch(fatal);
    void derivative?.start().catch(fatal);
  } catch {
    process.exitCode = 1;
    try {
      if (app) await app.close();
    } finally {
      await cleanup();
    }
    console.error(
      '{"event":"api_startup_refused","category":"STARTUP_FAILED"}',
    );
  }
}
void main().catch(() => {
  process.exitCode = 1;
  console.error('{"event":"api_stopped","category":"CLEANUP_FAILED"}');
});
