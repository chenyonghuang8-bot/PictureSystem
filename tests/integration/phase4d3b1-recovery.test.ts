import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ResultSetHeader, RowDataPacket } from "mysql2/promise";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { assertMigrationReadiness } from "../../packages/db/src/migration-readiness.js";
import {
  createDatabase,
  MySqlMediaRepository,
} from "../../packages/db/src/index.js";
import { reconcileDerivedPublishRecovery } from "../../packages/db/src/derived-recovery.js";
import { admitDerivedReservation } from "../../apps/worker/src/derived-admission.js";
import { MySqlDerivedAdmissionRepository } from "../../packages/db/src/derived-admission-repository.js";
import {
  CapacityGate,
  DerivedStore,
  StorageRoot,
} from "../../packages/storage/src/index.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("PHASE4D3B1_DEV_DATABASE_URL_REQUIRED");

function privateDirectory(path: string) {
  mkdirSync(path, { recursive: true });
  const segments = path.split("/");
  const rootIndex = segments.findIndex((segment) =>
    segment.startsWith("ps4d3b1r-"),
  );
  const start = rootIndex >= 0 ? rootIndex : segments.length - 1;
  for (let index = start; index < segments.length; index += 1) {
    chmodSync(segments.slice(0, index + 1).join("/"), 0o700);
  }
}

describe.sequential("Phase 4D3b-1 derived publish recovery", () => {
  const database = createDatabase(databaseUrl);
  const repository = new MySqlDerivedAdmissionRepository(database.pool);
  const mediaRepository = new MySqlMediaRepository(database.pool);
  const suffix = randomUUID().replaceAll("-", "");
  const mediaRoot = mkdtempSync(join(realpathSync(tmpdir()), "ps4d3b1r-"));
  let storageRoot: StorageRoot;
  let gate: CapacityGate;
  let store: DerivedStore;
  let familyId = "";
  let memberId = "";

  beforeAll(async () => {
    privateDirectory(mediaRoot);
    privateDirectory(join(mediaRoot, "derived"));
    const connection = await database.pool.getConnection();
    try {
      const [identity] = await connection.query<RowDataPacket[]>(
        `SELECT DATABASE() AS db, VERSION() AS version,
          CURRENT_USER() AS account,
          @@GLOBAL.innodb_native_foreign_keys AS nativeFk,
          @@SESSION.foreign_key_checks AS foreignKeyChecks`,
      );
      const row = identity[0];
      if (
        row?.db !== "family_album_dev" ||
        !String(row.version).startsWith("9.7.2") ||
        String(row.account).split("@")[0]?.toLowerCase() === "root" ||
        String(row.nativeFk) !== "1" ||
        String(row.foreignKeyChecks) !== "1"
      ) {
        throw new Error("PHASE4D3B1_DEV_PREFLIGHT_FAILED");
      }
      await assertMigrationReadiness(connection);
      const [family] = await connection.query<ResultSetHeader>(
        "INSERT INTO families (name) VALUES (?)",
        [`D3b1 synthetic ${suffix}`],
      );
      familyId = String(family.insertId);
      const username = `d3b1_${suffix}`;
      const [user] = await connection.query<ResultSetHeader>(
        `INSERT INTO users
          (username,username_normalized,password_hash,display_name,password_changed_at)
         VALUES (?,?,?,?,CURRENT_TIMESTAMP(3))`,
        [username, Buffer.from(username), "synthetic-not-used", "D3b1"],
      );
      const [member] = await connection.query<ResultSetHeader>(
        "INSERT INTO family_members (family_id,user_id,role) VALUES (?,?,'MEMBER')",
        [familyId, String(user.insertId)],
      );
      memberId = String(member.insertId);
    } finally {
      connection.release();
    }
    storageRoot = StorageRoot.open(mediaRoot, { initialize: true });
    storageRoot.provisionDerivedWriterLockForDev();
    storageRoot.provisionSharedCapacityLockForDev();
    gate = CapacityGate.open({
      mediaRoot,
      expectedMarkerId: storageRoot.markerId,
    });
    store = DerivedStore.open({ state: "READ_WRITE", root: storageRoot });
  });

  afterAll(async () => {
    store.close();
    gate.close();
    storageRoot.close();
    rmSync(mediaRoot, { recursive: true, force: true });
    const connection = await database.pool.getConnection();
    try {
      await connection.beginTransaction();
      await connection.query("DELETE FROM derived_assets WHERE family_id=?", [
        familyId,
      ]);
      await connection.query("DELETE FROM background_jobs WHERE family_id=?", [
        familyId,
      ]);
      await connection.query("DELETE FROM media_items WHERE family_id=?", [
        familyId,
      ]);
      await connection.query("DELETE FROM upload_sessions WHERE family_id=?", [
        familyId,
      ]);
      await connection.query("DELETE FROM storage_objects WHERE family_id=?", [
        familyId,
      ]);
      await connection.query("DELETE FROM family_members WHERE family_id=?", [
        familyId,
      ]);
      await connection.query("DELETE FROM users WHERE username=?", [
        `d3b1_${suffix}`,
      ]);
      await connection.query("DELETE FROM families WHERE id=?", [familyId]);
      await connection.commit();
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
      await database.pool.end();
    }
  });

  async function reservedIdentity() {
    const sha = createHash("sha256").update(randomBytes(16)).digest();
    const [object] = await database.pool.query<ResultSetHeader>(
      `INSERT INTO storage_objects
        (family_id,sha256,byte_size,key_version,state,durable_at,verified_at)
       VALUES (?,?,2048,1,'AVAILABLE',CURRENT_TIMESTAMP(3),CURRENT_TIMESTAMP(3))`,
      [familyId, sha],
    );
    const [upload] = await database.pool.query<ResultSetHeader>(
      `INSERT INTO upload_sessions
        (public_id,family_id,created_by_member_id,original_filename,
         declared_size,committed_offset,state,computed_sha256,
         finalize_started_at,storage_object_id,completed_at,expires_at)
       VALUES (?,?,?,'synthetic.bin',2048,2048,'COMPLETE',?,
         CURRENT_TIMESTAMP(3),?,CURRENT_TIMESTAMP(3),
         DATE_ADD(CURRENT_TIMESTAMP(3),INTERVAL 1 DAY))`,
      [randomBytes(16), familyId, memberId, sha, String(object.insertId)],
    );
    const created = await mediaRepository.createOrGetCanonicalMedia({
      familyId,
      uploadId: String(upload.insertId),
    });
    const workerId = randomBytes(16);
    const [job] = await database.pool.query<ResultSetHeader>(
      `INSERT INTO background_jobs
        (family_id,media_id,generation,recipe_id,job_type,state,attempts,
         max_attempts,available_at,locked_at,heartbeat_at,locked_until,
         worker_id,lease_epoch)
       VALUES (?,?,1,1,'IMAGE_DERIVATIVES','RUNNING',1,3,
         CURRENT_TIMESTAMP(3),CURRENT_TIMESTAMP(3),CURRENT_TIMESTAMP(3),
         DATE_ADD(CURRENT_TIMESTAMP(3),INTERVAL 90 SECOND),?,1)`,
      [familyId, created.media.id, workerId],
    );
    const identity = {
      familyId,
      mediaId: created.media.id,
      generation: 1n,
      recipeId: 1 as const,
      kind: "THUMBNAIL" as const,
      jobId: String(job.insertId),
      leaseEpoch: 1n,
      workerId,
    };
    const admitted = await admitDerivedReservation(
      { state: "READ_WRITE", root: storageRoot },
      gate,
      repository,
      identity,
    );
    expect(admitted.result.transaction).toBe("COMMITTED");
    const bytes = Buffer.from(`temp-${identity.jobId}`);
    const part = join(
      mediaRoot,
      "derived",
      ".tmp",
      identity.jobId,
      "e1",
      "thumbnail.part",
    );
    privateDirectory(join(mediaRoot, "derived", ".tmp", identity.jobId, "e1"));
    writeFileSync(part, bytes);
    chmodSync(part, 0o600);
    return { identity, part, bytes };
  }

  async function expireLease(jobId: string) {
    await database.pool.query(
      `UPDATE background_jobs
       SET state='RETRY_WAIT', last_failure_code='WORKER_LOST',
           locked_at=NULL, heartbeat_at=NULL, locked_until=NULL, worker_id=NULL
       WHERE id=? AND family_id=?`,
      [jobId, familyId],
    );
  }

  it("retains accounting until exact cleanup is durable, then releases without READY", async () => {
    const { identity, part, bytes } = await reservedIdentity();
    const inventory = await gate.recoveryInventory();
    expect(inventory.complete).toBe(true);
    const held = await reconcileDerivedPublishRecovery({
      pool: database.pool,
      capability: "READ_ONLY",
      inventoryComplete: true,
      temps: inventory.temps,
      finals: inventory.finals,
      cleanupExact: async () => {
        throw new Error("read-only cleanup");
      },
    });
    expect(held.map((item) => item.code)).toContain("TEMP_ONLY_RETAIN");
    expect(lstatSync(part).size).toBe(bytes.length);
    await expireLease(identity.jobId);
    let cleaned = false;
    const readonly = await reconcileDerivedPublishRecovery({
      pool: database.pool,
      capability: "READ_ONLY",
      inventoryComplete: true,
      temps: inventory.temps,
      finals: inventory.finals,
      cleanupExact: async () => {
        cleaned = true;
      },
    });
    expect(readonly.map((item) => item.code)).toContain("READ_ONLY_REPORT");
    expect(cleaned).toBe(false);
    const released = await reconcileDerivedPublishRecovery({
      pool: database.pool,
      capability: "READ_WRITE",
      inventoryComplete: true,
      temps: inventory.temps,
      finals: inventory.finals,
      cleanupExact: async (temp, row) => {
        store.cleanupExactTemp(
          { state: "READ_WRITE", root: storageRoot },
          {
            jobId: temp.jobId,
            epoch: temp.epoch,
            kind: temp.kind,
            byteSize: temp.byteSize,
            device: temp.device,
            inode: temp.inode,
            sha256Hex: temp.sha256Hex,
            familyId: row.familyId,
            mediaId: row.mediaId,
            generation: row.generation,
            recipeId: 1,
          },
        );
      },
    });
    expect(released.map((item) => item.code)).toContain("TEMP_ONLY_RELEASED");
    expect(() => lstatSync(part)).toThrow();
    const [rows] = await database.pool.query<RowDataPacket[]>(
      `SELECT derived_assets.state AS assetState, derived_assets.cleaned_at AS cleanedAt,
         background_jobs.state AS jobState, media_items.processing_state AS mediaState
       FROM derived_assets
       JOIN background_jobs ON background_jobs.id = derived_assets.producer_job_id
       JOIN media_items ON media_items.id = derived_assets.media_id
       WHERE derived_assets.producer_job_id=?`,
      [identity.jobId],
    );
    expect(rows[0]).toMatchObject({
      assetState: "RESERVED",
      jobState: "RETRY_WAIT",
    });
    expect(rows[0]?.cleanedAt).toBeInstanceOf(Date);
    expect(rows[0]?.mediaState).not.toBe("READY");
  });

  it("does not release accounting when the cleanup commit is unknown", async () => {
    const { identity, part } = await reservedIdentity();
    await expireLease(identity.jobId);
    const inventory = await gate.recoveryInventory();
    const result = await reconcileDerivedPublishRecovery({
      pool: database.pool,
      capability: "READ_WRITE",
      inventoryComplete: true,
      temps: inventory.temps,
      finals: inventory.finals,
      cleanupExact: async (temp, row) => {
        store.cleanupExactTemp(
          { state: "READ_WRITE", root: storageRoot },
          {
            jobId: temp.jobId,
            epoch: temp.epoch,
            kind: temp.kind,
            byteSize: temp.byteSize,
            device: temp.device,
            inode: temp.inode,
            sha256Hex: temp.sha256Hex,
            familyId: row.familyId,
            mediaId: row.mediaId,
            generation: row.generation,
            recipeId: 1,
          },
        );
      },
      commitForTest: async (connection) => {
        connection.destroy();
        throw new Error("commit lost");
      },
    });
    expect(result.map((item) => item.code)).toContain("ACCOUNTING_RETAINED");
    expect(() => lstatSync(part)).toThrow();
    const [rows] = await database.pool.query<RowDataPacket[]>(
      `SELECT state, cleaned_at AS cleanedAt FROM derived_assets
       WHERE producer_job_id=?`,
      [identity.jobId],
    );
    expect(rows[0]).toMatchObject({ state: "RESERVED", cleanedAt: null });
  });
});
