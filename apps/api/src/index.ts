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
  MySqlAdminReadRepository,
} from "@family-album/db";
import { resolve } from "node:path";
import { coordinatedDerivedReader } from "./derived-serving/reader.js";
import {
  CapacityGate,
  DerivedStore,
  OriginalReader,
  probeStorageCapability,
  StorageSafetyError,
  ControlAdmissionError,
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
import { UploadMutex } from "./uploads/mutex.js";
import {
  assessStorageStartup,
  confirmStorageStartup,
} from "./uploads/startup.js";
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
import {
  loadDeploymentControl,
  configuredControlRoles,
} from "../../worker/src/deployment-control.js";
import { assertStorageOwnerHealth } from "../../worker/src/storage-owner-health.js";
import {
  StorageRuntimeOwner,
  type RuntimeMediaResources,
} from "../../worker/src/storage-runtime-owner.js";
import { borrowedService } from "./admin/borrowed-service.js";

async function main() {
  const env = loadApiEnv();
  const database = createDatabase(env.DATABASE_URL);
  const localControlRoles =
    process.env.DEV_MEDIA_PIPELINE_ENABLED === "1"
      ? (["API", "DERIVATIVE"] as const)
      : (["API"] as const);
  const control = await loadDeploymentControl(database.pool, env, {
    path: process.env.DEV_CONTROL_PATH,
    deploymentId: process.env.DEV_CONTROL_DEPLOYMENT_ID,
    roles: localControlRoles,
    mediaRoot: resolve(process.cwd(), env.DEV_MEDIA_ROOT),
    markerId: env.DEV_STORAGE_MARKER_ID,
  });
  let storageCapability: StorageCapability = {
    state: "UNAVAILABLE",
    reason: "STORAGE_NOT_CONFIGURED",
  };
  let sharedCapacityGate: CapacityGate | undefined;
  let originalReader: OriginalReader | undefined;
  let derivedStore: DerivedStore | undefined;
  let reconciler: UploadPipelineReconciler | undefined;
  let derivative: ImageDerivativeDriver | undefined;
  let mediaOwner: StorageRuntimeOwner | undefined;
  let app: ReturnType<typeof createApp> | undefined;
  let cleanupPromise: Promise<void> | undefined;
  const requestStop = () => {
    reconciler?.requestStop();
    derivative?.requestStop();
    control.stop?.();
  };
  const cleanup = () =>
    (cleanupPromise ??= (async () => {
      try {
        await control.beginShutdown?.();
      } catch {
        /* No CLEAN without known STOPPING. */
      }
      requestStop();
      const results = await Promise.allSettled([
        reconciler?.drain(),
        derivative?.drain(),
      ]);
      let failed = results.some((r) => r.status === "rejected");
      try {
        await control.drain?.();
      } catch {
        failed = true;
      }
      if (mediaOwner) {
        try {
          await mediaOwner.resources.close();
        } catch {
          failed = true;
        }
      }
      for (const resource of mediaOwner
        ? []
        : [
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
        await control.resourcesClosed?.(!failed);
      } catch {
        failed = true;
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
    const enabled = process.env.DEV_MEDIA_PIPELINE_ENABLED;
    const requiredRoles = configuredControlRoles(
      enabled === "1" ? ["API", "DERIVATIVE"] : ["API"],
    );
    if (enabled !== undefined && enabled !== "0" && enabled !== "1")
      throw new Error("PIPELINE_ENABLE_INVALID");
    if (env.DEV_STORAGE_MARKER_ID && control.gate) {
      try {
        const connection = await acquireCheckedConnection(database.pool);
        try {
          await assertMigrationReadiness(connection);
          storageCapability = probeStorageCapability({
            mediaRoot: resolve(process.cwd(), env.DEV_MEDIA_ROOT),
            initialize: false,
            expectedMarkerId: env.DEV_STORAGE_MARKER_ID,
            ...(!control.startupWritable
              ? { readOnlyReason: "CONTROL_WRITE_PAUSED" }
              : {}),
          });
          if (storageCapability.state !== "UNAVAILABLE") {
            const ownerRoot = storageCapability.root;
            control.bindHealth?.(async () => {
              await assertStorageOwnerHealth(ownerRoot, control.repository, {
                ...(originalReader ? { reader: originalReader } : {}),
                ...(sharedCapacityGate ? { gate: sharedCapacityGate } : {}),
              });
            });
          }
          // PREPARING permits only handle opening/read-only fresh inspection.
          // Original repair remains solely in authorized owner recovery below.
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
      } catch {
        if (storageCapability.state !== "UNAVAILABLE")
          storageCapability.root.close();
        storageCapability = {
          state: "UNAVAILABLE",
          reason: "CONTROL_READINESS_UNAVAILABLE",
        };
        console.error(
          '{"event":"storage_startup_paused","category":"READINESS_UNAVAILABLE"}',
        );
      }
    }
    const derivedReads = new MySqlDerivedReadRepository(database.pool);
    let derivedReader = coordinatedDerivedReader(
      storageCapability,
      sharedCapacityGate,
    );
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
    if (
      enabled === "1" &&
      storageCapability.state === "READ_WRITE" &&
      sharedCapacityGate &&
      originalReader
    ) {
      try {
        derivedStore = DerivedStore.open(storageCapability);
      } catch {
        storageCapability = {
          state: "READ_ONLY",
          root: storageCapability.root,
          reason: "DERIVED_WRITER_UNAVAILABLE",
        };
        await control.trip?.("WRITER_NOT_READY").catch(() => {});
      }
    }
    if (
      storageCapability.state !== "UNAVAILABLE" &&
      env.DEV_STORAGE_MARKER_ID
    ) {
      mediaOwner = new StorageRuntimeOwner(
        {
          capability: storageCapability,
          ...(sharedCapacityGate ? { gate: sharedCapacityGate } : {}),
          ...(originalReader ? { reader: originalReader } : {}),
          ...(derivedStore ? { store: derivedStore } : {}),
        },
        database.pool,
        control.repository,
        {
          mediaRoot: resolve(process.cwd(), env.DEV_MEDIA_ROOT),
          markerId: env.DEV_STORAGE_MARKER_ID,
          roles: requiredRoles,
        },
        async (permit, resources) => {
          const assessed = await permit.run("STARTUP_ASSESS", () =>
            assessStorageStartup(
              uploadRepository,
              resources.capability,
              uploadMutex,
            ),
          );
          if (assessed.capability.state !== "READ_WRITE")
            throw Error("STORAGE_STARTUP_RECOVERY_INCOMPLETE");
          if (enabled === "1") {
            const recovered = new UploadPipelineReconciler({
              repository: new MySqlUploadPipelineRepository(database.pool),
              media: new MySqlMediaRepository(database.pool),
              jobs: new MySqlJobRepository(database.pool),
              acquire: UploadPipelineReconciler.acquire(
                assessed.capability.root,
              ),
            });
            const repository = new MySqlUploadPipelineRepository(database.pool);
            const throughId = await repository.readUploadPipelineHighWater();
            if (throughId) {
              const candidates = await repository.listUploadPipelinePage({
                afterId: "0",
                throughId,
                limit: 20,
              });
              for (const candidate of candidates) {
                const outcome = await recovered.reconcileFenced(
                  permit,
                  candidate,
                );
                if (["INVARIANT_REJECTED", "DEFERRED"].includes(outcome.result))
                  return false;
              }
            }
          }
          return true;
        },
        (resources) =>
          confirmStorageStartup(
            uploadRepository,
            resources.capability,
            uploadMutex,
          ),
      );
      control.bindOwner?.(mediaOwner);
      const owner = mediaOwner;
      derivedReader = {
        read: (identity, options) =>
          owner.resources.withValue((r) =>
            coordinatedDerivedReader(r.capability, r.gate).read(
              identity,
              options,
            ),
          ),
      };
    }
    const derivedService = new DerivedReadService(derivedReads, derivedReader);
    const unavailableOriginalReader: OriginalDownloadReader = {
      withVerifiedDownload: async () => {
        throw new StorageSafetyError("ORIGINAL_READER_UNAVAILABLE");
      },
    };
    const originalDownloadService = new OriginalDownloadService(
      albumRepository,
      mediaOwner
        ? {
            withVerifiedDownload: (identity, options, callback) =>
              mediaOwner!.resources.withValue((r) =>
                (r.reader ?? unavailableOriginalReader).withVerifiedDownload(
                  identity,
                  options,
                  callback,
                ),
              ),
          }
        : (originalReader ?? unavailableOriginalReader),
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
      control.admission,
    );
    const initialUploadService = new UploadService(
      uploadRepository,
      storageCapability,
      sharedCapacityGate,
    );
    const initialTrashService = new TrashService(
      new MySqlTrashRepository(database.pool),
      storageCapability,
    );
    const uploadServices = new WeakMap<RuntimeMediaResources, UploadService>();
    const trashServices = new WeakMap<RuntimeMediaResources, TrashService>();
    const uploadService = mediaOwner
      ? borrowedService<RuntimeMediaResources, UploadService>(
          mediaOwner.resources,
          (r) => {
            let service = uploadServices.get(r);
            if (!service) {
              service = new UploadService(
                uploadRepository,
                r.capability,
                r.gate,
              );
              uploadServices.set(r, service);
            }
            return service;
          },
          [
            "create",
            "result",
            "targets",
            "placement",
            "operation",
            "head",
            "patch",
            "status",
            "finalize",
            "abort",
          ],
          {
            maxFileSize: initialUploadService.maxFileSize,
            maxChunkSize: initialUploadService.maxChunkSize,
          },
        )
      : initialUploadService;
    const trashService = mediaOwner
      ? borrowedService<RuntimeMediaResources, TrashService>(
          mediaOwner.resources,
          (r) => {
            let service = trashServices.get(r);
            if (!service) {
              service = new TrashService(
                new MySqlTrashRepository(database.pool),
                r.capability,
              );
              trashServices.set(r, service);
            }
            return service;
          },
          ["list", "mutate", "permanentDelete", "purgeStatus"],
        )
      : initialTrashService;
    app = createApp({
      trashService,
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
      controlAdmission: control.admission,
      admin: {
        control: control.repository,
        reads: new MySqlAdminReadRepository(database.pool),
        localDeny: control.locallyDenied,
        configuredRoles: requiredRoles,
        observeStorage: (now) =>
          mediaOwner
            ? mediaOwner.observe(now)
            : Promise.resolve({
                state: "UNAVAILABLE",
                observedAt: now.toISOString(),
                staleAfter: new Date(now.getTime() + 5000).toISOString(),
                source: "STORAGE_OWNER",
                reasonCode: "WRITER_NOT_READY",
                totalBytes: null,
                availableBytes: null,
              }),
      },
    });

    if (enabled === "1") {
      const target = new URL(env.DATABASE_URL);
      if (
        env.APP_ENV !== "dev" ||
        target.pathname !== "/family_album_dev" ||
        !env.DEV_STORAGE_MARKER_ID ||
        decodeURIComponent(target.username).toLowerCase() === "root"
      )
        throw new Error("PIPELINE_DEV_STARTUP_REFUSED");
      // Loops exist while paused. Each admitted unit borrows the current
      // generation; no pipeline captures an old writable root/store/reader.
      if (mediaOwner) {
        const owner = mediaOwner;
        reconciler = new UploadPipelineReconciler(
          {
            repository: new MySqlUploadPipelineRepository(database.pool),
            media: new MySqlMediaRepository(database.pool),
            jobs: new MySqlJobRepository(database.pool),
            acquire: async () => {
              throw Error("PIPELINE_PROVIDER_REQUIRED");
            },
            withGuard: (candidate, operation) =>
              owner.resources.withValue(async (r) => {
                if (r.capability.state !== "READ_WRITE")
                  throw new ControlAdmissionError("WRITE_PAUSED");
                const guard = await UploadPipelineReconciler.acquire(
                  r.capability.root,
                )(candidate);
                return operation(guard);
              }),
            admission: control.admission,
          },
          (counts) =>
            app!.log.info(
              { event: "upload_pipeline_round", counts },
              "pipeline round assessed",
            ),
        );
        derivative = new ImageDerivativeDriver(
          database.pool,
          undefined,
          undefined,
          control.admission,
          (operation) =>
            owner.resources.withValue(async (r) => {
              if (
                r.capability.state !== "READ_WRITE" ||
                !r.gate ||
                !r.reader ||
                !r.store
              )
                throw new ControlAdmissionError("WRITE_PAUSED");
              const processor = ImageDerivativeDriver.createProcessor(
                database.pool,
                { capability: r.capability, gate: r.gate, store: r.store },
                r.reader,
              );
              return control.track
                ? control.track(
                    "DERIVATIVE",
                    () => operation(processor),
                    (result) =>
                      !(
                        result &&
                        typeof result === "object" &&
                        "outcome" in result &&
                        result.outcome === "IDLE"
                      ),
                  )
                : operation(processor);
            }),
        );
      }
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
        await control.beginShutdown?.().catch(() => {});
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
    control.onStopping?.(() => {
      void app!.close().catch(() => {
        process.exitCode = 1;
      });
    });
    await control.start?.([
      { role: "API", ready: () => app!.server.listening },
      ...(enabled === "1"
        ? [
            {
              role: "DERIVATIVE" as const,
              ready: () => derivative !== undefined && !derivative.stopped,
            },
          ]
        : []),
    ]);
    const fatal = () => {
      process.exitCode = 1;
      app!.log.error(
        {
          event: "media_pipeline_stopped",
          category: "EXECUTION_REFUSED_OR_UNKNOWN",
        },
        "pipeline stopped",
      );
      reconciler?.requestStop();
      derivative?.requestStop();
      void control.trip?.("RECOVERY_FAILED").catch(() => {});
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
