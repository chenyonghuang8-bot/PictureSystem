import { freshStorageRootPath } from "../fixtures/fresh-storage-root.js";
import { randomBytes, randomUUID, createHash } from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  rmSync,
  writeFileSync,
  existsSync,
  linkSync,
  symlinkSync,
  renameSync,
  readdirSync,
} from "node:fs";
import { join } from "node:path";
import { describe, it, expect, afterAll } from "vitest";
import {
  createDatabase,
  acquireCheckedConnection,
  PurgeIntentRepository,
  assertMigrationReadiness,
} from "../../packages/db/src/index.js";
import {
  createPhase6SchemaFixture,
  cleanupPhase6MigrationFixture,
} from "../../packages/db/scripts/phase6-schema-fixture.js";
import { readDerivedCapacityInventory } from "../../packages/db/src/capacity-inventory.js";
import {
  StorageRoot,
  DerivedStore,
  CapacityGate,
} from "../../packages/storage/src/index.js";
import { PurgeDerivedNormalizer } from "../../apps/worker/src/purge-normalization.js";
import type { RowDataPacket } from "mysql2/promise";
import { createRequire } from "node:module";
import { purgeBindings } from "../../packages/storage/src/purge-bindings.js";
import type { PurgeDerivedNative } from "../../packages/storage/src/purge-derived.js";
import { ContentCoordination } from "../../packages/storage/src/phase7-coordination.js";
import { MySqlDerivedAssetFence } from "../../packages/db/src/derived-asset-fence.js";
import {
  MySqlTrashRepository,
  MySqlUploadRepository,
} from "../../packages/db/dist/index.js";
import { TrashService } from "../../apps/api/src/trash/service.js";
import { PurgeScheduleRepository } from "../../packages/db/src/purge-scheduler.js";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("PHASE7C_DEV_ENV_REQUIRED");
const db = createDatabase(url);
const ownedFamilies = new Set<string>();
const ownedRoots = new Set<string>();
afterAll(async () => {
  const c = await acquireCheckedConnection(db.pool);
  try {
    expect((await assertMigrationReadiness(c)).migrationCount).toBe(8);
    for (const familyId of ownedFamilies) {
      for (const table of [
        "families",
        "audit_logs",
        "purge_files",
        "purge_intents",
        "media_items",
        "upload_sessions",
        "storage_objects",
        "derived_assets",
        "background_jobs",
      ]) {
        const [rows] = await c.query<RowDataPacket[]>(
          `SELECT COUNT(*) n FROM ${table} WHERE ${table === "families" ? "id" : "family_id"}=?`,
          [familyId],
        );
        expect(Number(rows[0]!.n)).toBe(0);
      }
    }
    for (const path of ownedRoots) expect(existsSync(path)).toBe(false);
  } finally {
    c.release();
    await db.pool.end();
  }
});
describe.sequential("Phase 7C pre-detach normalization live DEV", () => {
  it("requests irreversible manual purge with current ACL, retention and idempotent audit; scheduled loser cannot create another", async () => {
    const c = await acquireCheckedConnection(db.pool);
    const dir = freshStorageRootPath("ps7c-request-");
    const root = StorageRoot.open(dir, { initialize: true });
    chmodSync(dir, 0o700);
    ownedRoots.add(root.canonicalPath);
    let f: Awaited<ReturnType<typeof createPhase6SchemaFixture>> | undefined;
    try {
      await c.beginTransaction();
      f = await createPhase6SchemaFixture(c);
      ownedFamilies.add(f.familyId);
      await c.execute("UPDATE family_members SET role='ADMIN' WHERE id=?", [
        f.actorMemberId,
      ]);
      const tokenHash = randomBytes(32);
      await c.execute(
        `INSERT INTO sessions (user_id,token_hash,client_type,authenticated_at,last_seen_at,expires_at,created_at)
       VALUES (?,?,'WEB',CURRENT_TIMESTAMP(3),CURRENT_TIMESTAMP(3),CURRENT_TIMESTAMP(3)+INTERVAL 1 DAY,CURRENT_TIMESTAMP(3))`,
        [f.actorUserId, tokenHash],
      );
      const [sessions] = await c.query<RowDataPacket[]>(
        "SELECT CAST(LAST_INSERT_ID() AS CHAR) id",
      );
      await c.execute(
        "INSERT INTO albums (family_id,owner_member_id,name,visibility) VALUES (?,?,'synthetic-7c-request','CUSTOM')",
        [f.familyId, f.actorMemberId],
      );
      const [albums] = await c.query<RowDataPacket[]>(
        "SELECT CAST(LAST_INSERT_ID() AS CHAR) id",
      );
      await c.execute(
        "INSERT INTO album_media (family_id,album_id,media_id) VALUES (?,?,?)",
        [f.familyId, albums[0]!.id, f.mediaId],
      );
      await c.execute(
        `UPDATE media_items SET trashed_at=CURRENT_TIMESTAMP(3),purge_after=CURRENT_TIMESTAMP(3)+INTERVAL 30 DAY,
       trashed_by_member_id=?,lifecycle_revision=2 WHERE id=?`,
        [f.memberId, f.mediaId],
      );
      await c.commit();
      const repository = new MySqlTrashRepository(db.pool),
        service = new TrashService(repository, { state: "READ_WRITE", root });
      const context = {
        identity: { userId: f.actorUserId, sessionId: sessions[0]!.id },
        tokenHash,
      } as Parameters<TrashService["permanentDelete"]>[0];
      const input = {
        familyId: f.familyId,
        mediaId: f.mediaId,
        expectedLifecycleRevision: "2",
        operationId: randomUUID(),
      };
      await expect(
        service.permanentDelete(context, input),
      ).rejects.toMatchObject({ statusCode: 409 });
      await c.execute(
        `UPDATE media_items SET trashed_at=CURRENT_TIMESTAMP(3)-INTERVAL 31 DAY,purge_after=CURRENT_TIMESTAMP(3)-INTERVAL 1 DAY WHERE id=?`,
        [f.mediaId],
      );
      const [keys] = await c.query<RowDataPacket[]>(
        "SELECT LOWER(HEX(sha256)) sha FROM storage_objects WHERE id=?",
        [f.objectId],
      );
      const scheduled = {
        familyId: f.familyId,
        mediaId: f.mediaId,
        storageId: f.objectId,
        sourceId: f.uploadId,
        revision: "2",
        sha256Hex: keys[0]!.sha,
        byteSize: "16",
        purgeAfter: new Date(),
      };
      await c.execute("UPDATE family_members SET role='MEMBER' WHERE id=?", [
        f.actorMemberId,
      ]);
      await expect(
        service.permanentDelete(context, input),
      ).rejects.toMatchObject({ statusCode: 403 });
      await c.execute("UPDATE family_members SET role='ADMIN' WHERE id=?", [
        f.actorMemberId,
      ]);
      expect(await service.permanentDelete(context, input)).toEqual({
        operationId: input.operationId,
      });
      expect(await service.permanentDelete(context, input)).toEqual({
        operationId: input.operationId,
      });
      await expect(
        service.permanentDelete(context, {
          ...input,
          operationId: randomUUID(),
        }),
      ).rejects.toMatchObject({ statusCode: 409 });
      expect(
        await new PurgeScheduleRepository(db.pool).request(scheduled),
      ).toBeNull();
      expect(
        await service.purgeStatus(context, {
          familyId: f.familyId,
          operationId: input.operationId,
        }),
      ).toEqual({
        operationId: input.operationId,
        executionState: "QUEUED",
        progress: "REQUESTED",
        completedAt: null,
        failureCategory: null,
      });
      const [rows] = await c.query<RowDataPacket[]>(
        "SELECT CAST(lifecycle_revision AS CHAR) revision FROM media_items WHERE id=?",
        [f.mediaId],
      );
      expect(rows[0]!.revision).toBe("3");
      const [audits] = await c.query<RowDataPacket[]>(
        "SELECT COUNT(*) n FROM audit_logs WHERE family_id=? AND action='PERMANENT_DELETE_REQUEST'",
        [f.familyId],
      );
      expect(Number(audits[0]!.n)).toBe(1);
    } finally {
      await c.rollback();
      if (f) {
        await c.execute("DELETE FROM audit_logs WHERE family_id=?", [
          f.familyId,
        ]);
        await c.execute(
          "UPDATE media_items SET purge_intent_id=NULL WHERE family_id=?",
          [f.familyId],
        );
        await c.execute("DELETE FROM purge_intents WHERE family_id=?", [
          f.familyId,
        ]);
        await c.execute("DELETE FROM album_media WHERE family_id=?", [
          f.familyId,
        ]);
        await c.execute("DELETE FROM albums WHERE family_id=?", [f.familyId]);
        await c.execute("DELETE FROM sessions WHERE user_id=?", [
          f.actorUserId,
        ]);
        await cleanupPhase6MigrationFixture(c, f);
      }
      c.release();
      root.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it.each([
    ["RESERVED", "temp", 0o600],
    ["RESERVED", "temp", 0o400],
    ["PUBLISHING", "temp", 0o400],
    ["PUBLISHING", "final", 0o400],
    ["RESERVED", "final", 0o400],
    ["FAILED", "temp", 0o400],
    ["MISSING", "final", 0o400],
    ["RESERVED", "dual", 0o400],
    ["RESERVED", "absent", 0o400],
    ["RESERVED", "crash", 0o400],
    ["RESERVED", "fsync", 0o400],
    ["RESERVED", "unknown-before", 0o400],
    ["RESERVED", "unknown-after", 0o400],
    ["RESERVED", "race", 0o400],
    ["RESERVED", "lease-loss", 0o400],
  ] as const)(
    "normalizes %s %s without waiting for producer lease expiry",
    async (state, residue, mode) => {
      const c = await acquireCheckedConnection(db.pool);
      const mediaRoot = freshStorageRootPath("ps7c-db-");
      const root = StorageRoot.open(mediaRoot, { initialize: true });
      chmodSync(mediaRoot, 0o700);
      mkdirSync(join(mediaRoot, "derived"), { mode: 0o700 });
      ownedRoots.add(root.canonicalPath);
      root.provisionDerivedWriterLockForDev();
      root.provisionSharedCapacityLockForDev();
      const store = DerivedStore.open({ state: "READ_WRITE", root });
      const gate = CapacityGate.open({
        mediaRoot,
        expectedMarkerId: root.markerId,
      });
      let f: Awaited<ReturnType<typeof createPhase6SchemaFixture>> | undefined;
      try {
        await c.beginTransaction();
        f = await createPhase6SchemaFixture(c);
        ownedFamilies.add(f.familyId);
        await c.execute(
          `UPDATE media_items SET trashed_at=CURRENT_TIMESTAMP(3)-INTERVAL 31 DAY,
       purge_after=CURRENT_TIMESTAMP(3)-INTERVAL 1 DAY,trashed_by_member_id=?,lifecycle_revision=2 WHERE id=?`,
          [f.memberId, f.mediaId],
        );
        const [dates] = await c.query<RowDataPacket[]>(
          "SELECT trashed_at trashedAt,purge_after purgeAfter FROM media_items WHERE id=?",
          [f.mediaId],
        );
        const intent = await new PurgeIntentRepository(db.pool).create(c, {
          familyId: f.familyId,
          operationId: randomUUID(),
          mediaId: f.mediaId,
          storageObjectId: f.objectId,
          sourceUploadId: f.uploadId,
          lifecycleRevision: 2n,
          trashedAt: dates[0]!.trashedAt,
          purgeAfter: dates[0]!.purgeAfter,
          requestSource: "SCHEDULED",
          actorMemberId: null,
          originalBytes: 16n,
        });
        await c.execute("UPDATE media_items SET purge_intent_id=? WHERE id=?", [
          intent.id,
          f.mediaId,
        ]);
        const workerId = randomBytes(16);
        await c.execute(
          `UPDATE purge_intents SET execution_state='RUNNING',worker_id=?,lease_epoch=1,
       locked_at=CURRENT_TIMESTAMP(3),heartbeat_at=CURRENT_TIMESTAMP(3),locked_until=CURRENT_TIMESTAMP(3)+INTERVAL 90 SECOND,attempts=1 WHERE id=?`,
          [workerId, intent.id],
        );
        const producerWorker = randomBytes(16);
        await c.execute(
          `INSERT INTO background_jobs (family_id,media_id,generation,recipe_id,job_type,state,lease_epoch,worker_id,locked_at,heartbeat_at,locked_until,available_at)
       VALUES (?,?,1,1,'IMAGE_DERIVATIVES','RUNNING',7,?,CURRENT_TIMESTAMP(3),CURRENT_TIMESTAMP(3),CURRENT_TIMESTAMP(3)+INTERVAL 90 SECOND,CURRENT_TIMESTAMP(3))`,
          [f.familyId, f.mediaId, producerWorker],
        );
        const [ids] = await c.query<RowDataPacket[]>(
          "SELECT CAST(LAST_INSERT_ID() AS CHAR) id",
        );
        const jobId = String(ids[0]!.id),
          bytes = Buffer.from("synthetic-purge"),
          sha = createHash("sha256").update(bytes).digest();
        await c.execute(
          `INSERT INTO derived_assets (family_id,media_id,generation,recipe_id,kind,state,reserved_bytes,producer_job_id,producer_lease_epoch,
       byte_size,sha256,width,height,output_mime,failure_code)
       VALUES (?,?,1,1,'THUMBNAIL',?,524288,?,5,?,?,?,?,?,?)`,
          [
            f.familyId,
            f.mediaId,
            state,
            jobId,
            state === "PUBLISHING" ? bytes.length : null,
            state === "PUBLISHING" ? sha : null,
            state === "PUBLISHING" ? 1 : null,
            state === "PUBLISHING" ? 1 : null,
            state === "PUBLISHING" ? "image/webp" : null,
            ["FAILED", "MISSING"].includes(state) ? "DERIVED_INTEGRITY" : null,
          ],
        );
        await c.commit();
        const privatePath = (parts: string[]) => {
          let parent = mediaRoot;
          for (const part of parts) {
            parent = join(parent, part);
            mkdirSync(parent, { recursive: true, mode: 0o700 });
            chmodSync(parent, 0o700);
          }
          return parent;
        };
        const temp = join(
          privatePath(["derived", ".tmp", jobId, "e5"]),
          "thumbnail.part",
        );
        const final = join(
          privatePath(["derived", f.familyId, f.mediaId, "r1", "g1"]),
          "thumbnail.webp",
        );
        for (const target of residue === "dual"
          ? [temp, final]
          : residue === "final"
            ? [final]
            : residue === "absent"
              ? []
              : [temp]) {
          writeFileSync(target, bytes, { mode });
          chmodSync(target, mode);
        }
        expect(
          (await readDerivedCapacityInventory(c)).familyUsage.get(f.familyId),
        ).toBe(524288n);
        const normalizer = new PurgeDerivedNormalizer(
          db.pool,
          root,
          store,
          gate,
        );
        let lease = { id: intent.id, epoch: 1n, workerId };
        if (residue === "lease-loss") {
          await expect(
            new PurgeDerivedNormalizer(db.pool, root, store, gate, {
              afterPhysicalAbsence: async () => {
                await c.execute(
                  `UPDATE purge_intents SET locked_at=CURRENT_TIMESTAMP(3)-INTERVAL 2 MINUTE,
             heartbeat_at=CURRENT_TIMESTAMP(3)-INTERVAL 2 MINUTE,locked_until=CURRENT_TIMESTAMP(3)-INTERVAL 1 MINUTE WHERE id=?`,
                  [intent.id],
                );
              },
            }).run(lease),
          ).rejects.toThrow("PURGE_ACCOUNTING_UNSETTLED");
          expect(
            (await readDerivedCapacityInventory(c)).familyUsage.get(f.familyId),
          ).toBe(524288n);
          await c.execute(
            `UPDATE purge_intents SET lease_epoch=2,locked_at=CURRENT_TIMESTAMP(3),heartbeat_at=CURRENT_TIMESTAMP(3),
         locked_until=CURRENT_TIMESTAMP(3)+INTERVAL 90 SECOND WHERE id=?`,
            [intent.id],
          );
          lease = { ...lease, epoch: 2n };
        }
        if (residue === "crash") {
          await expect(
            new PurgeDerivedNormalizer(db.pool, root, store, gate, {
              afterPhysicalAbsence: async () => {
                expect(existsSync(temp)).toBe(false);
                expect(
                  (await readDerivedCapacityInventory(c)).familyUsage.get(
                    f!.familyId,
                  ),
                ).toBe(524288n);
                throw new Error("PURGE_SIMULATED_CRASH");
              },
            }).run(lease),
          ).rejects.toThrow("PURGE_SIMULATED_CRASH");
        }
        if (residue === "fsync") {
          const addon = createRequire(import.meta.url)(
            join(
              import.meta.dirname,
              "../../packages/storage/build/storage_native_test.node",
            ),
          ) as NonNullable<
            ConstructorParameters<typeof PurgeDerivedNative>[3]
          > & { failNextPurgeDirectorySync(store: object): void };
          addon.failNextPurgeDirectorySync(purgeBindings(root, store).derived);
          await expect(
            new PurgeDerivedNormalizer(db.pool, root, store, gate, {
              nativeBinding: addon,
            }).run(lease),
          ).rejects.toThrow("PURGE_FILESYSTEM_UNCERTAIN");
          expect(existsSync(temp)).toBe(false);
          expect(
            (await readDerivedCapacityInventory(c)).familyUsage.get(f.familyId),
          ).toBe(524288n);
        }
        if (residue === "unknown-before" || residue === "unknown-after") {
          expect(
            await new PurgeDerivedNormalizer(db.pool, root, store, gate, {
              commitCleaned: async (connection) => {
                if (residue === "unknown-after") await connection.commit();
                else await connection.rollback();
                throw new Error("PURGE_SIMULATED_COMMIT_UNKNOWN");
              },
            }).run(lease),
          ).toBe("COMMIT_UNKNOWN");
          expect(
            (await readDerivedCapacityInventory(c)).familyUsage.get(
              f.familyId,
            ) ?? 0n,
          ).toBe(residue === "unknown-after" ? 0n : 524288n);
        }
        if (residue === "race") {
          const [keys] = await c.query<RowDataPacket[]>(
            "SELECT LOWER(HEX(sha256)) sha FROM storage_objects WHERE id=?",
            [f.objectId],
          );
          const producer = new ContentCoordination(root, {
            familyId: f.familyId,
            sha256Hex: keys[0]!.sha,
            byteSize: "16",
          });
          const life = await producer.acquireLifecycle("S", 0),
            read = await producer.acquireRead(life, "S", 0);
          try {
            await expect(normalizer.run(lease)).rejects.toThrow(
              "COORD_ACQUIRE_TIMEOUT",
            );
            expect(existsSync(temp)).toBe(true);
            expect(
              (await readDerivedCapacityInventory(c)).familyUsage.get(
                f.familyId,
              ),
            ).toBe(524288n);
          } finally {
            read.close();
            life.close();
          }
        }
        expect(await normalizer.run(lease)).toBe("NORMALIZED");
        expect(existsSync(temp)).toBe(false);
        expect(existsSync(final)).toBe(false);
        expect(
          (await readDerivedCapacityInventory(c)).familyUsage.get(f.familyId) ??
            0n,
        ).toBe(0n);
        expect(await normalizer.run(lease)).toBe("NORMALIZED");
        const [rows] = await c.query<RowDataPacket[]>(
          "SELECT state,CAST(reserved_bytes AS CHAR) reservation,cleaned_at cleanedAt FROM derived_assets WHERE family_id=?",
          [f.familyId],
        );
        expect(rows[0]).toMatchObject({ state, reservation: "524288" });
        expect(rows[0]!.cleanedAt).toBeInstanceOf(Date);
        expect(
          await new MySqlDerivedAssetFence(db.pool).describe({
            familyId: f.familyId,
            mediaId: f.mediaId,
            generation: 1n,
            recipeId: 1,
            jobId,
            workerId: producerWorker,
            leaseEpoch: 7n,
            lifecycleRevision: 1n,
          }),
        ).toBeNull();
      } finally {
        await c.rollback();
        if (f) {
          await c.execute("DELETE FROM derived_assets WHERE family_id=?", [
            f.familyId,
          ]);
          await c.execute("DELETE FROM background_jobs WHERE family_id=?", [
            f.familyId,
          ]);
          await c.execute(
            "UPDATE media_items SET purge_intent_id=NULL WHERE family_id=?",
            [f.familyId],
          );
          await c.execute("DELETE FROM purge_intents WHERE family_id=?", [
            f.familyId,
          ]);
          await c.execute("DELETE FROM sessions WHERE user_id=?", [f.userId]);
          await c.execute("DELETE FROM tags WHERE family_id=?", [f.familyId]);
          await c.execute("DELETE FROM albums WHERE family_id=?", [f.familyId]);
          await cleanupPhase6MigrationFixture(c, f);
        }
        c.release();
        gate.close();
        store.close();
        root.close();
        rmSync(mediaRoot, { recursive: true, force: true });
      }
    },
  );
});

import { spawn } from "node:child_process";
import { once } from "node:events";
import { Readable } from "node:stream";
import { UploadService } from "../../apps/api/src/uploads/service.js";
import { MySqlMediaRepository } from "../../packages/db/src/media-repository.js";
import type { PurgeFilesNative } from "../../packages/storage/src/purge-files.js";
import { PurgeScheduler } from "../../apps/worker/src/purge-scheduler.js";
import { PurgeProcessor } from "../../apps/worker/src/purge-processor.js";
import {
  purgeSlot,
  lockPurgeExecution,
  changePurgeFile,
} from "../../packages/db/src/purge-execution.js";
import { runCapacityTransaction } from "../../packages/db/src/capacity-transaction.js";
describe.sequential("Phase 7C full purge live DEV", () => {
  it.each([
    "success",
    "DETACHED",
    "AFTER_QUARANTINE",
    "UNLINK_ARMED",
    "AFTER_UNLINK",
    "REMOVED",
    "BEFORE_COMPLETE",
    "FILES_REMOVED",
    "original-AFTER_QUARANTINE",
    "original-UNLINK_ARMED",
    "original-AFTER_UNLINK",
    "original-armed-absence",
    "reader-race",
    "reader-retry",
    "unsafe-ledger",
    "derived-replacement-before-claim",
    "derived-replacement-before-physical",
    "coord-v1-before-claim",
    "coord-parent-before-claim",
    "coord-v1-before-physical",
    "coord-parent-before-physical",
    "last-derived-removed",
    "last-derived-removed-original-blocked",
    "unreleased-original-quarantined",
    "unreleased-original-armed",
    "stale-worker",
    "failure-audit",
    "scheduled-worker",
    "fsync-quarantine",
    "fsync-unlink",
    "fsync-original-quarantine",
    "fsync-original-unlink",
    "original-sha-conflict",
    "original-size-conflict",
    "original-mode",
    "original-hardlink",
    "original-symlink",
    "armed-inode-conflict",
    "process-AFTER_QUARANTINE",
    "process-UNLINK_ARMED",
    "process-AFTER_UNLINK",
    "process-FILES_REMOVED",
    "process-BEFORE_COMPLETE",
    "process-original-AFTER_QUARANTINE",
    "process-original-AFTER_UNLINK",
    "process-last-derived-removed",
    "unknown-DETACH-before",
    "unknown-DETACH-after",
    "unknown-ARM-before",
    "unknown-ARM-after",
    "unknown-REMOVED-before",
    "unknown-REMOVED-after",
    "unknown-RELEASE-before",
    "unknown-RELEASE-after",
    "unknown-COMPLETE-before",
    "unknown-COMPLETE-after",
    "derived-absent",
    "original-absent",

    "finalizing-reference",
    "lease-loss",
    "slot-conflict",
    "quarantine-missing",
    "armed-absence",
  ])(
    "%s preserves durable state and converges without replay",
    async (scenario) => {
      const c = await acquireCheckedConnection(db.pool);
      const dir = freshStorageRootPath("ps7c-execute-");
      let root = StorageRoot.open(dir, { initialize: true });
      chmodSync(dir, 0o700);
      mkdirSync(join(dir, "derived"), { mode: 0o700 });
      ownedRoots.add(root.canonicalPath);
      root.provisionDerivedWriterLockForDev();
      root.provisionSharedCapacityLockForDev();
      let store = DerivedStore.open({ state: "READ_WRITE", root }),
        gate = CapacityGate.open({
          mediaRoot: dir,
          expectedMarkerId: root.markerId,
        });
      let f: Awaited<ReturnType<typeof createPhase6SchemaFixture>> | undefined;
      try {
        await c.beginTransaction();
        f = await createPhase6SchemaFixture(c);
        ownedFamilies.add(f.familyId);
        const bytes = Buffer.from("synthetic-origin"),
          sha = createHash("sha256").update(bytes).digest();
        expect(bytes.length).toBe(16);
        await c.execute("UPDATE storage_objects SET sha256=? WHERE id=?", [
          sha,
          f.objectId,
        ]);
        await c.execute(
          "UPDATE upload_sessions SET computed_sha256=? WHERE id=?",
          [sha, f.uploadId],
        );
        await c.execute(
          `UPDATE media_items SET trashed_at=CURRENT_TIMESTAMP(3)-INTERVAL 31 DAY,purge_after=CURRENT_TIMESTAMP(3)-INTERVAL 1 DAY,
        trashed_by_member_id=?,lifecycle_revision=2 WHERE id=?`,
          [f.memberId, f.mediaId],
        );
        const [dates] = await c.query<RowDataPacket[]>(
          "SELECT trashed_at trashedAt,purge_after purgeAfter FROM media_items WHERE id=?",
          [f.mediaId],
        );
        let intent = await new PurgeIntentRepository(db.pool).create(c, {
          familyId: f.familyId,
          operationId: randomUUID(),
          mediaId: f.mediaId,
          storageObjectId: f.objectId,
          sourceUploadId: f.uploadId,
          lifecycleRevision: 2n,
          trashedAt: dates[0]!.trashedAt,
          purgeAfter: dates[0]!.purgeAfter,
          requestSource: "SCHEDULED",
          actorMemberId: null,
          originalBytes: 16n,
        });
        await c.execute("UPDATE media_items SET purge_intent_id=? WHERE id=?", [
          intent.id,
          f.mediaId,
        ]);
        const workerId = randomBytes(16);
        let lease = { id: intent.id, epoch: 1n, workerId };
        await c.execute(
          `UPDATE purge_intents SET execution_state='RUNNING',worker_id=?,lease_epoch=1,attempts=1,
        locked_at=CURRENT_TIMESTAMP(3),heartbeat_at=CURRENT_TIMESTAMP(3),locked_until=CURRENT_TIMESTAMP(3)+INTERVAL 90 SECOND WHERE id=?`,
          [workerId, intent.id],
        );
        await c.execute(
          `INSERT INTO background_jobs (family_id,media_id,generation,recipe_id,job_type,state,lease_epoch,available_at)
        VALUES (?,?,1,1,'IMAGE_DERIVATIVES','QUEUED',1,CURRENT_TIMESTAMP(3))`,
          [f.familyId, f.mediaId],
        );
        const [jobs] = await c.query<RowDataPacket[]>(
          "SELECT CAST(LAST_INSERT_ID() AS CHAR) id",
        );
        const jobId = jobs[0]!.id;
        const derived = Buffer.from("synthetic-derived"),
          dsha = createHash("sha256").update(derived).digest();
        await c.execute(
          `INSERT INTO derived_assets (family_id,media_id,generation,recipe_id,kind,state,reserved_bytes,producer_job_id,producer_lease_epoch,
        byte_size,sha256,width,height,output_mime,published_at) VALUES (?,?,1,1,'THUMBNAIL','READY',524288,?,1,?,?,1,1,'image/webp',CURRENT_TIMESTAMP(3))`,
          [f.familyId, f.mediaId, jobId, derived.length, dsha],
        );
        await c.execute(
          `INSERT INTO background_jobs (family_id,media_id,generation,recipe_id,job_type,state,lease_epoch,available_at)
          VALUES (?,?,2,1,'IMAGE_DERIVATIVES','QUEUED',1,CURRENT_TIMESTAMP(3))`,
          [f.familyId, f.mediaId],
        );
        const [secondJobs] = await c.query<RowDataPacket[]>(
          "SELECT CAST(LAST_INSERT_ID() AS CHAR) id",
        );
        await c.execute(
          `INSERT INTO derived_assets (family_id,media_id,generation,recipe_id,kind,state,reserved_bytes,producer_job_id,producer_lease_epoch,
          byte_size,sha256,width,height,output_mime,published_at) VALUES (?,?,2,1,'PREVIEW','READY',4194304,?,1,?,?,1,1,'image/webp',CURRENT_TIMESTAMP(3))`,
          [f.familyId, f.mediaId, secondJobs[0]!.id, derived.length, dsha],
        );
        await c.execute(
          "UPDATE media_items SET description='synthetic old note' WHERE id=?",
          [f.mediaId],
        );
        await c.execute(
          "INSERT INTO albums (family_id,owner_member_id,name,visibility) VALUES (?,?,'synthetic-purge-album','FAMILY')",
          [f.familyId, f.memberId],
        );
        const [albums] = await c.query<RowDataPacket[]>(
          "SELECT CAST(LAST_INSERT_ID() AS CHAR) id",
        );
        await c.execute(
          "INSERT INTO album_media (family_id,album_id,media_id) VALUES (?,?,?)",
          [f.familyId, albums[0]!.id, f.mediaId],
        );
        await c.execute(
          "INSERT INTO user_favorites (family_id,member_id,media_id) VALUES (?,?,?)",
          [f.familyId, f.memberId, f.mediaId],
        );
        await c.execute(
          "INSERT INTO family_featured (family_id,featured_by_member_id,media_id) VALUES (?,?,?)",
          [f.familyId, f.memberId, f.mediaId],
        );
        await c.execute(
          "INSERT INTO tags (family_id,name,name_normalized) VALUES (?,'synthetic-purge-tag',?)",
          [f.familyId, Buffer.from("synthetic-purge-tag")],
        );
        const [tags] = await c.query<RowDataPacket[]>(
          "SELECT CAST(LAST_INSERT_ID() AS CHAR) id",
        );
        await c.execute(
          "INSERT INTO media_tags (family_id,media_id,tag_id) VALUES (?,?,?)",
          [f.familyId, f.mediaId, tags[0]!.id],
        );
        await c.execute(
          "INSERT INTO comments (family_id,author_member_id,media_id,body) VALUES (?,?,?,'synthetic old comment')",
          [f.familyId, f.memberId, f.mediaId],
        );
        // Two COMPLETE receipts share the object. Both must retire, preserving staging charge.
        await c.execute(
          `INSERT INTO upload_sessions (public_id,family_id,created_by_member_id,original_filename,declared_size,committed_offset,state,
        computed_sha256,finalize_started_at,storage_object_id,completed_at,expires_at) VALUES (?,?,?,'synthetic-repeat.bin',16,16,'COMPLETE',?,CURRENT_TIMESTAMP(3),?,CURRENT_TIMESTAMP(3),CURRENT_TIMESTAMP(3)+INTERVAL 1 DAY)`,
          [randomBytes(16), f.familyId, f.memberId, sha, f.objectId],
        );
        await c.commit();
        const make = (parts: string[], leaf: string, data: Buffer) => {
          let parent = dir;
          for (const part of parts) {
            parent = join(parent, part);
            mkdirSync(parent, { recursive: true, mode: 0o700 });
            chmodSync(parent, 0o700);
          }
          const path = join(parent, leaf);
          writeFileSync(path, data, { mode: 0o400 });
          chmodSync(path, 0o400);
          return path;
        };
        const hex = sha.toString("hex"),
          original = make(
            ["originals", f.familyId, hex.slice(0, 2), hex.slice(2, 4)],
            `${hex}-16`,
            bytes,
          );
        const final = make(
          ["derived", f.familyId, f.mediaId, "r1", "g1"],
          "thumbnail.webp",
          derived,
        );
        const preview = make(
          ["derived", f.familyId, f.mediaId, "r1", "g2"],
          "preview.webp",
          derived,
        );
        const replaceCoord = () => {
          const target = join(
            dir,
            scenario.startsWith("coord-v1") ? ".coord/v1" : ".coord",
          );
          renameSync(target, `${target}-held`);
          mkdirSync(target, { mode: 0o700 });
        };
        const replaceDerived = () => {
          renameSync(join(dir, "derived"), join(dir, "moved-derived"));
          mkdirSync(join(dir, "derived"), { mode: 0o700 });
          make(
            ["derived", f!.familyId, f!.mediaId, "r1", "g1"],
            "thumbnail.webp",
            derived,
          );
          make(
            ["derived", f!.familyId, f!.mediaId, "r1", "g2"],
            "preview.webp",
            derived,
          );
        };
        if (
          [
            "reader-retry",
            "unsafe-ledger",
            "derived-replacement-before-claim",
            "coord-v1-before-claim",
            "coord-parent-before-claim",
          ].includes(scenario)
        ) {
          const [other] = await c.query<RowDataPacket[]>(
            `SELECT COUNT(*) n FROM purge_intents WHERE id<>? AND
              ((execution_state IN ('QUEUED','RETRY_WAIT') AND available_at<=CURRENT_TIMESTAMP(3))
                OR (execution_state='RUNNING' AND locked_until<CURRENT_TIMESTAMP(3)))`,
            [intent.id],
          );
          expect(Number(other[0]!.n)).toBe(0);
          await c.execute(
            `UPDATE purge_intents SET execution_state='QUEUED',worker_id=NULL,lease_epoch=0,attempts=0,
            locked_at=NULL,heartbeat_at=NULL,locked_until=NULL WHERE id=?`,
            [intent.id],
          );
        }
        if (scenario === "derived-absent") rmSync(final);
        if (scenario === "original-absent") rmSync(original);
        if (scenario === "finalizing-reference")
          await c.execute(
            `UPDATE upload_sessions SET state='FINALIZING',storage_object_id=NULL,completed_at=NULL WHERE family_id=? AND id<>?`,
            [f.familyId, f.uploadId],
          );
        if (scenario === "scheduled-worker") {
          const [unrelated] = await c.query<RowDataPacket[]>(
            `SELECT COUNT(*) n FROM purge_intents WHERE id<>? AND ((execution_state IN ('QUEUED','RETRY_WAIT') AND available_at<=CURRENT_TIMESTAMP(3)) OR (execution_state='RUNNING' AND locked_until<CURRENT_TIMESTAMP(3)))`,
            [intent.id],
          );
          expect(Number(unrelated[0]!.n)).toBe(0);
          const [due] = await c.query<RowDataPacket[]>(
            `SELECT COUNT(*) n FROM media_items WHERE id<>? AND trashed_at IS NOT NULL AND purge_after<=CURRENT_TIMESTAMP(3) AND purge_intent_id IS NULL`,
            [f.mediaId],
          );
          expect(Number(due[0]!.n)).toBe(0);
          await c.execute(
            "UPDATE media_items SET purge_intent_id=NULL WHERE id=?",
            [f.mediaId],
          );
          await c.execute("DELETE FROM purge_intents WHERE id=?", [intent.id]);
          const scanner = new PurgeScheduler(
            new PurgeScheduleRepository(db.pool),
            root,
          );
          expect((await scanner.scan(1)).requested).toBe(1);
          const [scheduled] = await c.query<RowDataPacket[]>(
            "SELECT CAST(id AS CHAR) id FROM purge_intents WHERE family_id=?",
            [f.familyId],
          );
          intent = { id: scheduled[0]!.id, created: true };
          lease = { id: intent.id, epoch: 1n, workerId };
        }
        let injected = false;
        const seen = new Map<string, number>();
        const faultBinding = scenario.startsWith("fsync-")
          ? (createRequire(import.meta.url)(
              join(
                import.meta.dirname,
                "../../packages/storage/build/storage_native_test.node",
              ),
            ) as NonNullable<
              ConstructorParameters<typeof PurgeFilesNative>[3]
            > & { failNextPurgeDirectorySync(store: object): void })
          : undefined;
        const processor = new PurgeProcessor(db.pool, root, store, gate, {
          nativeFilesBinding: faultBinding,
          boundary: async (name) => {
            seen.set(name, (seen.get(name) ?? 0) + 1);
            if (
              (name === "BEFORE_QUARANTINE" || name === "BEFORE_UNLINK") &&
              seen.get(name) === 3
            ) {
              const [bytes] = await c.query<RowDataPacket[]>(
                "SELECT CAST(derived_bytes AS CHAR) derivedBytes,CAST(released_bytes AS CHAR) releasedBytes FROM purge_intents WHERE id=?",
                [intent.id],
              );
              expect(BigInt(bytes[0]!.releasedBytes)).toBeGreaterThanOrEqual(
                BigInt(bytes[0]!.derivedBytes),
              );
            }
            if (injected) return;
            const lastDerived = name === "REMOVED" && seen.get(name) === 2;
            const oldOriginal =
              (scenario === "unreleased-original-quarantined" &&
                name === "QUARANTINED" &&
                seen.get(name) === 3) ||
              (scenario === "unreleased-original-armed" &&
                name === "UNLINK_ARMED" &&
                seen.get(name) === 3);
            if (
              (lastDerived && scenario.startsWith("last-derived-removed")) ||
              oldOriginal
            ) {
              injected = true;
              if (oldOriginal)
                await c.execute(
                  "UPDATE purge_intents SET released_bytes=0 WHERE id=?",
                  [intent.id],
                );
              const rejected = await gate.withAdmissionLock((deadline) =>
                runCapacityTransaction(
                  db.pool,
                  deadline,
                  async (connection) => {
                    const view = await lockPurgeExecution(
                      connection,
                      lease,
                      f!.familyId,
                    );
                    const originalFile = view.files.find(
                      (file) => file.fileKind === "ORIGINAL",
                    )!;
                    await changePurgeFile(
                      connection,
                      lease,
                      f!.familyId,
                      originalFile,
                      originalFile.stage === "CATALOGUED"
                        ? "QUARANTINED"
                        : originalFile.stage === "QUARANTINED"
                          ? "UNLINK_ARMED"
                          : "REMOVED",
                      { device: root.device, inode: "1" },
                    );
                  },
                ),
              );
              expect(rejected.transaction).toBe("ROLLED_BACK");
              if (rejected.transaction === "ROLLED_BACK")
                expect(rejected.error).toMatchObject({
                  message: "PURGE_DERIVED_UNRELEASED",
                });
              if (scenario === "last-derived-removed-original-blocked") {
                chmodSync(original, 0o600);
                writeFileSync(original, Buffer.from("different-origin"));
                chmodSync(original, 0o400);
              }
              throw new Error("PURGE_SIMULATED_CRASH");
            }
            if (
              name === "DETACHED" &&
              scenario === "derived-replacement-before-physical"
            ) {
              injected = true;
              replaceDerived();
            }
            if (
              name === "BEFORE_QUARANTINE" &&
              seen.get(name) === 1 &&
              scenario.startsWith("coord-") &&
              scenario.endsWith("before-physical")
            ) {
              injected = true;
              replaceCoord();
            }
            if (
              faultBinding &&
              ((name === "BEFORE_QUARANTINE" &&
                scenario.endsWith("quarantine")) ||
                (name === "BEFORE_UNLINK" && scenario.endsWith("unlink"))) &&
              seen.get(name) === (scenario.includes("original-") ? 3 : 1)
            ) {
              injected = true;
              faultBinding.failNextPurgeDirectorySync(
                purgeBindings(root, store).derived,
              );
            }
            if (name === "DETACHED") {
              expect(
                (await readDerivedCapacityInventory(c)).familyUsage.get(
                  f!.familyId,
                ),
              ).toBe(BigInt(derived.length * 2));
              const [receipts] = await c.query<RowDataPacket[]>(
                "SELECT state FROM upload_sessions WHERE family_id=?",
                [f!.familyId],
              );
              expect(receipts.map((r) => r.state)).toEqual([
                "RETIRED",
                "RETIRED",
              ]);
              if (scenario !== "original-absent")
                expect(existsSync(original)).toBe(true);
            }
            if (name === "REMOVED" && seen.get(name) === 1) {
              expect(
                (await readDerivedCapacityInventory(c)).familyUsage.get(
                  f!.familyId,
                ),
              ).toBe(BigInt(derived.length * 2));
              if (scenario !== "original-absent")
                expect(existsSync(original)).toBe(true);
            }
            if (
              scenario === name ||
              (scenario === `original-${name}` && seen.get(name) === 3)
            ) {
              injected = true;
              throw new Error("PURGE_SIMULATED_CRASH");
            }
            if (
              name === "DETACHED" &&
              scenario.startsWith("original-") &&
              [
                "original-sha-conflict",
                "original-size-conflict",
                "original-mode",
                "original-hardlink",
                "original-symlink",
              ].includes(scenario)
            ) {
              injected = true;
              if (scenario === "original-mode") chmodSync(original, 0o600);
              if (
                scenario === "original-sha-conflict" ||
                scenario === "original-size-conflict"
              ) {
                chmodSync(original, 0o600);
                writeFileSync(
                  original,
                  scenario === "original-size-conflict"
                    ? Buffer.from("wrong-size")
                    : Buffer.from("different-origin"),
                );
                chmodSync(original, 0o400);
              }
              if (scenario === "original-hardlink")
                linkSync(original, join(dir, "temp", "synthetic-hardlink"));
              if (scenario === "original-symlink") {
                const other = make(["temp"], "synthetic-link-target", bytes);
                rmSync(original);
                symlinkSync(other, original);
              }
            }
            if (
              name === "UNLINK_ARMED" &&
              scenario === "armed-inode-conflict"
            ) {
              injected = true;
              const [files] = await c.query<RowDataPacket[]>(
                "SELECT LOWER(HEX(quarantine_slot)) slot FROM purge_files WHERE purge_intent_id=? AND stage='UNLINK_ARMED'",
                [intent.id],
              );
              const replacement = make(
                ["temp"],
                "synthetic-slot-replacement",
                derived,
              );
              const slot = join(dir, ".purge", "v1", files[0]!.slot);
              rmSync(slot);
              renameSync(replacement, slot);
            }
            if (name === "AFTER_QUARANTINE" && scenario === "lease-loss") {
              injected = true;
              await c.execute(
                "UPDATE purge_intents SET locked_until=CURRENT_TIMESTAMP(3)-INTERVAL 1 SECOND WHERE id=?",
                [intent.id],
              );
            }
            if (
              name === "UNLINK_ARMED" &&
              (scenario === "armed-absence" ||
                (scenario === "original-armed-absence" && seen.get(name) === 3))
            ) {
              injected = true;
              const [files] = await c.query<RowDataPacket[]>(
                "SELECT CAST(id AS CHAR) id FROM purge_files WHERE purge_intent_id=? AND stage='UNLINK_ARMED'",
                [intent.id],
              );
              rmSync(
                join(
                  dir,
                  ".purge",
                  "v1",
                  purgeSlot(intent.id, files[0]!.id).toString("hex"),
                ),
              );
              throw new Error("PURGE_SIMULATED_CRASH");
            }
            if (name === "DETACHED" && scenario === "slot-conflict") {
              injected = true;
              const [files] = await c.query<RowDataPacket[]>(
                "SELECT CAST(id AS CHAR) id FROM purge_files WHERE purge_intent_id=? AND file_kind='DERIVED'",
                [intent.id],
              );
              make(
                [".purge", "v1"],
                purgeSlot(intent.id, files[0]!.id).toString("hex"),
                derived,
              );
            }
            if (name === "UNLINK_ARMED" && scenario === "quarantine-missing")
              return;
            if (name === "QUARANTINED" && scenario === "quarantine-missing") {
              // A missing unarmed quarantine must fail closed.
              injected = true;
              const [files] = await c.query<RowDataPacket[]>(
                "SELECT LOWER(HEX(quarantine_slot)) slot FROM purge_files WHERE purge_intent_id=? AND stage='QUARANTINED'",
                [intent.id],
              );
              rmSync(join(dir, ".purge", "v1", files[0]!.slot));
              throw new Error("PURGE_SIMULATED_CRASH");
            }
          },
          commit: async (name, connection) => {
            const target = `unknown-${name}-`;
            if (!injected && scenario.startsWith(target)) {
              if (name === "RELEASE") {
                const [pending] = await connection.query<RowDataPacket[]>(
                  "SELECT COUNT(*) n FROM purge_files WHERE purge_intent_id=? AND file_kind='DERIVED' AND stage NOT IN ('REMOVED','ABSENT_DERIVED')",
                  [intent.id],
                );
                if (Number(pending[0]!.n)) {
                  await connection.commit();
                  return;
                }
              }
              injected = true;
              if (scenario.endsWith("after")) await connection.commit();
              else await connection.rollback();
              throw new Error("PURGE_SIMULATED_COMMIT_UNKNOWN");
            }
            await connection.commit();
          },
        });
        if (
          scenario.startsWith("coord-") &&
          scenario.endsWith("before-claim")
        ) {
          const reader = await new ContentCoordination(root, {
            familyId: f.familyId,
            sha256Hex: hex,
            byteSize: "16",
          }).acquireReadOnly(0);
          try {
            replaceCoord();
            await expect(processor.runNext()).rejects.toThrow(
              /COORD_NAMESPACE_UNCERTAIN/,
            );
            const [state] = await c.query<RowDataPacket[]>(
              "SELECT progress,execution_state state,attempts,CAST(released_bytes AS CHAR) releasedBytes FROM purge_intents WHERE id=?",
              [intent.id],
            );
            expect(state[0]).toMatchObject({
              progress: "REQUESTED",
              state: "QUEUED",
              attempts: 0,
              releasedBytes: "0",
            });
            const [files] = await c.query<RowDataPacket[]>(
              "SELECT id FROM purge_files WHERE purge_intent_id=?",
              [intent.id],
            );
            const [audit] = await c.query<RowDataPacket[]>(
              "SELECT action FROM audit_logs WHERE purge_intent_id=?",
              [intent.id],
            );
            expect(files).toHaveLength(0);
            expect(audit).toHaveLength(0);
            expect(
              (await readDerivedCapacityInventory(c)).familyUsage.get(
                f.familyId,
              ),
            ).toBe(BigInt(derived.length * 2));
            expect(existsSync(original)).toBe(true);
            expect(existsSync(final)).toBe(true);
            expect(existsSync(preview)).toBe(true);
            expect(existsSync(join(dir, ".purge"))).toBe(false);
          } finally {
            reader.close();
          }
          return;
        }
        if (scenario === "derived-replacement-before-claim") {
          replaceDerived();
          await expect(processor.runNext()).rejects.toThrow(
            "PURGE_WRITER_REQUIRED",
          );
          const [state] = await c.query<RowDataPacket[]>(
            "SELECT progress,execution_state state,attempts,CAST(released_bytes AS CHAR) releasedBytes FROM purge_intents WHERE id=?",
            [intent.id],
          );
          expect(state[0]).toMatchObject({
            progress: "REQUESTED",
            state: "QUEUED",
            attempts: 0,
            releasedBytes: "0",
          });
          expect(
            (await readDerivedCapacityInventory(c)).familyUsage.get(f.familyId),
          ).toBe(BigInt(derived.length * 2));
          for (const namespace of ["derived", "moved-derived"]) {
            expect(
              existsSync(
                join(
                  dir,
                  namespace,
                  f.familyId,
                  f.mediaId,
                  "r1",
                  "g1",
                  "thumbnail.webp",
                ),
              ),
            ).toBe(true);
          }
          expect(existsSync(original)).toBe(true);
          return;
        }
        if (scenario === "reader-retry" || scenario === "unsafe-ledger") {
          const content = new ContentCoordination(root, {
            familyId: f.familyId,
            sha256Hex: hex,
            byteSize: "16",
          });
          const reader = await content.acquireReadOnly(0);
          if (scenario === "unsafe-ledger") {
            reader.close();
            const coordDir = join(dir, ".coord", "v1");
            const readName = readdirSync(coordDir).find((name) =>
              name.endsWith(".R"),
            )!;
            const ledger = join(coordDir, `${readName.slice(0, 64)}.h`);
            mkdirSync(ledger, { mode: 0o700 });
            writeFileSync(
              join(ledger, `${"a".repeat(32)}.rec`),
              Buffer.from("invalid-ledger"),
              { mode: 0o600 },
            );
          }
          try {
            expect(await processor.runNext()).toBe(true);
            const [state] = await c.query<RowDataPacket[]>(
              "SELECT execution_state state,failure_category category,progress FROM purge_intents WHERE id=?",
              [intent.id],
            );
            expect(state[0]).toMatchObject({
              state: scenario === "unsafe-ledger" ? "BLOCKED" : "RETRY_WAIT",
              category:
                scenario === "unsafe-ledger"
                  ? "INVARIANT_VIOLATION"
                  : "TRANSIENT_DB",
              progress: "REQUESTED",
            });
            expect(existsSync(original)).toBe(true);
            expect(existsSync(final)).toBe(true);
            expect(existsSync(join(dir, ".purge"))).toBe(false);
            const [audit] = await c.query<RowDataPacket[]>(
              "SELECT action,result_category FROM audit_logs WHERE purge_intent_id=?",
              [intent.id],
            );
            expect(audit).toHaveLength(1);
            expect(audit[0]).toMatchObject({
              action: "PURGE_FAILED",
              result_category:
                scenario === "unsafe-ledger"
                  ? "INVARIANT_VIOLATION"
                  : "TRANSIENT_DB",
            });
          } finally {
            if (scenario !== "unsafe-ledger") reader.close();
          }
          if (scenario === "unsafe-ledger") return;
          await c.execute(
            "UPDATE purge_intents SET available_at=CURRENT_TIMESTAMP(3) WHERE id=?",
            [intent.id],
          );
        }
        if (scenario === "reader-race") {
          const coordination = new ContentCoordination(root, {
            familyId: f.familyId,
            sha256Hex: hex,
            byteSize: "16",
          });
          const reader = await coordination.acquireReadOnly(0);
          try {
            await expect(processor.run(lease)).rejects.toThrow(
              "COORD_ACQUIRE_TIMEOUT",
            );
            expect(existsSync(original)).toBe(true);
          } finally {
            reader.close();
          }
        }
        if (scenario === "stale-worker") {
          await expect(
            processor.run({ ...lease, epoch: 0n }),
          ).rejects.toThrow();
          expect(existsSync(original)).toBe(true);
        }
        if (scenario === "failure-audit") {
          const repo = new PurgeIntentRepository(db.pool);
          expect(await repo.fail(lease, "FILESYSTEM_UNCERTAIN", null)).toBe(
            true,
          );
          expect(await repo.fail(lease, "FILESYSTEM_UNCERTAIN", null)).toBe(
            false,
          );
          const [audits] = await c.query<RowDataPacket[]>(
            "SELECT action,transition_id,result_category FROM audit_logs WHERE purge_intent_id=?",
            [intent.id],
          );
          expect(audits).toHaveLength(1);
          expect(audits[0]).toMatchObject({
            action: "PURGE_FAILED",
            transition_id: "1",
            result_category: "FILESYSTEM_UNCERTAIN",
          });
          expect(existsSync(original)).toBe(true);
          return;
        }
        const blocked = [
          "original-absent",

          "finalizing-reference",
          "slot-conflict",
          "original-sha-conflict",
          "original-size-conflict",
          "original-mode",
          "original-hardlink",
          "original-symlink",
          "armed-inode-conflict",
        ];
        if (blocked.includes(scenario)) {
          await expect(processor.run(lease)).rejects.toThrow(/^PURGE_/);
          if (scenario !== "original-absent")
            expect(existsSync(original)).toBe(true);
          return;
        }
        if (scenario.startsWith("process-")) {
          gate.close();
          store.close();
          root.close();
          const boundary =
            scenario === "process-last-derived-removed"
              ? "REMOVED"
              : scenario.slice("process-".length).replace("original-", "");
          const occurrence =
            scenario === "process-last-derived-removed"
              ? 2
              : scenario.includes("original-")
                ? 3
                : 1;
          const script = `
            import { createDatabase } from './packages/db/src/index.ts';
            import { StorageRoot,DerivedStore,CapacityGate } from './packages/storage/src/index.ts';
            import { PurgeProcessor } from './apps/worker/src/purge-processor.ts';
            const database=createDatabase(process.env.DATABASE_URL);
            const root=StorageRoot.open(${JSON.stringify(dir)},{initialize:false});
            const store=DerivedStore.open({state:'READ_WRITE',root});
            const gate=CapacityGate.open({mediaRoot:root.canonicalPath,expectedMarkerId:root.markerId});
            let count=0;
            await new PurgeProcessor(database.pool,root,store,gate,{boundary:async name=>{
              if(name===${JSON.stringify(boundary)}&&++count===${occurrence}) {
                process.send({boundary:name});await new Promise(()=>{});
              }
            }}).run({id:${JSON.stringify(intent.id)},epoch:1n,workerId:Buffer.from(${JSON.stringify(workerId.toString("hex"))},'hex')});
            process.exit(2);
          `;
          const child = spawn(
            process.execPath,
            ["--import", "tsx", "--input-type=module", "-e", script],
            {
              cwd: process.cwd(),
              env: { ...process.env, NODE_ENV: "test" },
              stdio: ["ignore", "ignore", "ignore", "ipc"],
            },
          );
          const exited = once(child, "exit");
          try {
            await Promise.race([
              once(child, "message"),
              exited.then(() => {
                throw new Error("PURGE_CHILD_EXITED_BEFORE_BOUNDARY");
              }),
            ]);
            child.kill("SIGKILL");
            const [code, signal] = await exited;
            expect(code).toBeNull();
            expect(signal).toBe("SIGKILL");
          } finally {
            if (child.exitCode === null && child.signalCode === null) {
              child.kill("SIGKILL");
              await exited;
            }
          }
          root = StorageRoot.open(dir, { initialize: false });
          store = DerivedStore.open({ state: "READ_WRITE", root });
          gate = CapacityGate.open({
            mediaRoot: dir,
            expectedMarkerId: root.markerId,
          });
        } else if (
          scenario === "scheduled-worker" ||
          scenario === "reader-retry"
        )
          expect(await processor.runNext()).toBe(true);
        else if (
          ["success", "derived-absent", "reader-race", "stale-worker"].includes(
            scenario,
          )
        )
          await processor.run(lease);
        else await expect(processor.run(lease)).rejects.toThrow(/^PURGE_/);
        if (scenario === "lease-loss") {
          lease = { ...lease, epoch: 2n };
          await c.execute(
            `UPDATE purge_intents SET lease_epoch=2,locked_until=CURRENT_TIMESTAMP(3)+INTERVAL 90 SECOND WHERE id=?`,
            [intent.id],
          );
        }
        if (scenario === "quarantine-missing") {
          await expect(
            new PurgeProcessor(db.pool, root, store, gate).run(lease),
          ).rejects.toThrow("PURGE_FILESYSTEM_UNCERTAIN");
          expect(existsSync(original)).toBe(true);
          return;
        }
        if (
          scenario.startsWith("coord-") &&
          scenario.endsWith("before-physical")
        ) {
          const [files] = await c.query<RowDataPacket[]>(
            "SELECT stage FROM purge_files WHERE purge_intent_id=?",
            [intent.id],
          );
          expect(files.every((file) => file.stage === "CATALOGUED")).toBe(true);
          const [state] = await c.query<RowDataPacket[]>(
            "SELECT progress,CAST(released_bytes AS CHAR) releasedBytes FROM purge_intents WHERE id=?",
            [intent.id],
          );
          expect(state[0]).toMatchObject({
            progress: "DETACHED",
            releasedBytes: "0",
          });
          expect(
            (await readDerivedCapacityInventory(c)).familyUsage.get(f.familyId),
          ).toBe(BigInt(derived.length * 2));
          expect(existsSync(original)).toBe(true);
          expect(existsSync(final)).toBe(true);
          expect(existsSync(preview)).toBe(true);
          expect(existsSync(join(dir, ".purge"))).toBe(false);
          const [audits] = await c.query<RowDataPacket[]>(
            "SELECT action FROM audit_logs WHERE purge_intent_id=?",
            [intent.id],
          );
          expect(audits.map((a) => a.action)).toEqual(["PURGE_STARTED"]);
          return;
        }
        if (scenario === "derived-replacement-before-physical") {
          const [files] = await c.query<RowDataPacket[]>(
            "SELECT stage FROM purge_files WHERE purge_intent_id=?",
            [intent.id],
          );
          expect(files.every((file) => file.stage === "CATALOGUED")).toBe(true);
          const [state] = await c.query<RowDataPacket[]>(
            "SELECT progress,CAST(released_bytes AS CHAR) releasedBytes FROM purge_intents WHERE id=?",
            [intent.id],
          );
          expect(state[0]).toMatchObject({
            progress: "DETACHED",
            releasedBytes: "0",
          });
          expect(
            (await readDerivedCapacityInventory(c)).familyUsage.get(f.familyId),
          ).toBe(BigInt(derived.length * 2));
          for (const namespace of ["derived", "moved-derived"])
            expect(
              existsSync(
                join(
                  dir,
                  namespace,
                  f.familyId,
                  f.mediaId,
                  "r1",
                  "g1",
                  "thumbnail.webp",
                ),
              ),
            ).toBe(true);
          expect(existsSync(original)).toBe(true);
          return;
        }
        if (scenario === "last-derived-removed-original-blocked") {
          await expect(
            new PurgeProcessor(db.pool, root, store, gate).run(lease),
          ).rejects.toThrow("PURGE_FILESYSTEM_UNCERTAIN");
          const [state] = await c.query<RowDataPacket[]>(
            "SELECT CAST(released_bytes AS CHAR) releasedBytes,CAST(derived_bytes AS CHAR) derivedBytes FROM purge_intents WHERE id=?",
            [intent.id],
          );
          expect(state[0]!.releasedBytes).toBe(state[0]!.derivedBytes);
          expect(
            (await readDerivedCapacityInventory(c)).familyUsage.get(
              f.familyId,
            ) ?? 0n,
          ).toBe(0n);
          expect(existsSync(original)).toBe(true);
          return;
        }
        const resumedMutations: string[] = [];
        await new PurgeProcessor(db.pool, root, store, gate, {
          commit: async (name, connection) => {
            if (name !== "READ") resumedMutations.push(name);
            await connection.commit();
          },
          boundary: async (name) => {
            if (name !== "BEFORE_QUARANTINE" && name !== "BEFORE_UNLINK")
              return;
            const [pending] = await c.query<RowDataPacket[]>(
              "SELECT COUNT(*) n FROM purge_files WHERE purge_intent_id=? AND file_kind='DERIVED' AND stage NOT IN ('REMOVED','ABSENT_DERIVED')",
              [intent.id],
            );
            if (Number(pending[0]!.n) === 0) {
              const [state] = await c.query<RowDataPacket[]>(
                "SELECT CAST(derived_bytes AS CHAR) derivedBytes,CAST(released_bytes AS CHAR) releasedBytes FROM purge_intents WHERE id=?",
                [intent.id],
              );
              expect(BigInt(state[0]!.releasedBytes)).toBeGreaterThanOrEqual(
                BigInt(state[0]!.derivedBytes),
              );
            }
          },
        }).run(lease);
        if (
          [
            "last-derived-removed",
            "process-last-derived-removed",
            "unreleased-original-quarantined",
            "unreleased-original-armed",
            "unknown-RELEASE-before",
          ].includes(scenario)
        )
          expect(resumedMutations[0]).toBe("RELEASE");
        const [done] = await c.query<RowDataPacket[]>(
          "SELECT progress,execution_state executionState,CAST(released_bytes AS CHAR) releasedBytes FROM purge_intents WHERE id=?",
          [intent.id],
        );
        expect(done[0]).toMatchObject({
          progress: "COMPLETED",
          executionState: "DONE",
          releasedBytes: String(bytes.length + derived.length * 2),
        });
        expect(existsSync(original)).toBe(false);
        expect(existsSync(final)).toBe(false);
        expect(existsSync(preview)).toBe(false);
        expect(
          (await readDerivedCapacityInventory(c)).familyUsage.get(f.familyId) ??
            0n,
        ).toBe(0n);
        const [stages] = await c.query<RowDataPacket[]>(
          "SELECT file_kind kind,stage FROM purge_files WHERE purge_intent_id=?",
          [intent.id],
        );
        expect(stages.filter((r) => r.kind === "ORIGINAL")[0]!.stage).toBe(
          "REMOVED",
        );
        const [audits] = await c.query<RowDataPacket[]>(
          "SELECT action FROM audit_logs WHERE purge_intent_id=? ORDER BY id",
          [intent.id],
        );
        expect(audits.map((r) => r.action)).toEqual(
          scenario === "reader-retry"
            ? ["PURGE_FAILED", "PURGE_STARTED", "PURGE_COMPLETED"]
            : scenario === "scheduled-worker"
              ? ["PERMANENT_DELETE_REQUEST", "PURGE_STARTED", "PURGE_COMPLETED"]
              : ["PURGE_STARTED", "PURGE_COMPLETED"],
        );
        // Old retired receipt never creates media. A new same-byte upload obtains
        // a fresh storage identity after completed purge; the historical manifest survives.
        const tokenHash = randomBytes(32);
        await c.execute(
          `INSERT INTO sessions (user_id,token_hash,client_type,authenticated_at,last_seen_at,expires_at,created_at)
          VALUES (?,?,'WEB',CURRENT_TIMESTAMP(3),CURRENT_TIMESTAMP(3),CURRENT_TIMESTAMP(3)+INTERVAL 1 DAY,CURRENT_TIMESTAMP(3))`,
          [f.userId, tokenHash],
        );
        const [sessions] = await c.query<RowDataPacket[]>(
          "SELECT CAST(LAST_INSERT_ID() AS CHAR) id",
        );
        const context = {
          identity: { userId: f.userId, sessionId: sessions[0]!.id },
          tokenHash,
        } as Parameters<UploadService["create"]>[0];
        const service = new UploadService(
          new MySqlUploadRepository(db.pool),
          { state: "READ_WRITE", root },
          gate,
        );
        const [oldReceipts] = await c.query<RowDataPacket[]>(
          "SELECT public_id publicId FROM upload_sessions WHERE id=?",
          [f.uploadId],
        );
        await expect(
          service.finalize(context, oldReceipts[0]!.publicId),
        ).rejects.toMatchObject({
          status_code: 409,
          code: "UPLOAD_STATE_CONFLICT",
        });
        await expect(
          new MySqlMediaRepository(db.pool).createOrGetCanonicalMedia({
            familyId: f.familyId,
            uploadId: f.uploadId,
          }),
        ).rejects.toThrow("RECEIPT_NOT_COMPLETE");
        const publicId = randomBytes(16);
        const uploaded = await service.create(context, {
          familyId: f.familyId,
          publicId,
          declaredSize: 16n,
          filename: "synthetic-new-upload.bin",
          reportedMime: "application/octet-stream",
        });
        await service.patch(context, publicId, 0n, Readable.from([bytes]));
        expect(await service.finalize(context, publicId)).toMatchObject({
          state: "COMPLETE",
        });
        const newUploadId = uploaded.id;
        expect(newUploadId).not.toBe(f.uploadId);
        const canonical = await new MySqlMediaRepository(
          db.pool,
        ).createOrGetCanonicalMedia({
          familyId: f.familyId,
          uploadId: newUploadId,
        });
        expect(canonical.created).toBe(true);
        expect(canonical.media.id).not.toBe(f.mediaId);
        expect(canonical.media.storageObjectId).not.toBe(f.objectId);
        const newMedia = [{ id: canonical.media.id }];
        const [note] = await c.query<RowDataPacket[]>(
          "SELECT description FROM media_items WHERE id=?",
          [newMedia[0]!.id],
        );
        expect(note[0]!.description).toBeNull();
        for (const table of [
          "album_media",
          "user_favorites",
          "family_featured",
          "media_tags",
          "comments",
        ]) {
          const [relations] = await c.query<RowDataPacket[]>(
            `SELECT COUNT(*) n FROM ${table} WHERE family_id=?`,
            [f.familyId],
          );
          expect(Number(relations[0]!.n)).toBe(0);
        }
        const [dictionary] = await c.query<RowDataPacket[]>(
          "SELECT id FROM tags WHERE family_id=?",
          [f.familyId],
        );
        expect(dictionary).toHaveLength(1);
        expect(
          await new PurgeProcessor(db.pool, root, store, gate).run(lease),
        ).toBe("COMPLETED");
        expect(existsSync(original)).toBe(true);
      } finally {
        await c.rollback();
        if (f) {
          for (const table of [
            "audit_logs",
            "album_media",
            "user_favorites",
            "family_featured",
            "media_tags",
            "comments",
            "derived_assets",
            "background_jobs",
          ])
            await c.execute(`DELETE FROM ${table} WHERE family_id=?`, [
              f.familyId,
            ]);
          await c.execute("DELETE FROM media_items WHERE family_id=?", [
            f.familyId,
          ]);
          await c.execute("DELETE FROM upload_sessions WHERE family_id=?", [
            f.familyId,
          ]);
          await c.execute("DELETE FROM purge_files WHERE family_id=?", [
            f.familyId,
          ]);
          await c.execute("DELETE FROM purge_intents WHERE family_id=?", [
            f.familyId,
          ]);
          await c.execute("DELETE FROM storage_objects WHERE family_id=?", [
            f.familyId,
          ]);
          await c.execute("DELETE FROM sessions WHERE user_id=?", [f.userId]);
          await c.execute("DELETE FROM tags WHERE family_id=?", [f.familyId]);
          await c.execute("DELETE FROM albums WHERE family_id=?", [f.familyId]);
          await cleanupPhase6MigrationFixture(c, f);
        }
        c.release();
        gate.close();
        store.close();
        root.close();
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );
});
