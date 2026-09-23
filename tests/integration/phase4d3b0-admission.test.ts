import { createHash, randomBytes, randomUUID } from "node:crypto";
import { fork } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";

import type { ResultSetHeader, RowDataPacket } from "mysql2/promise";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import {
  assertMigrationReadiness,
  correlateDerivedFilesystemInventory,
  createDatabase,
  MySqlDerivedAdmissionRepository,
  MySqlMediaRepository,
  MySqlUploadRepository,
  type DerivedReservationIdentity,
} from "../../packages/db/dist/index.js";
import { runCapacityTransaction } from "../../packages/db/dist/capacity-transaction.js";
import { CapacityGate, StorageRoot } from "../../packages/storage/src/index.js";
import { UploadService } from "../../apps/api/src/uploads/service.js";
import type { AuthContext } from "../../apps/api/src/auth/service.js";
import {
  admitDerivedReservation,
  DerivedTempAdmissionPermit,
  isDerivedTempAdmissionPermit,
} from "../../apps/worker/src/derived-admission.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("PHASE4D3B0_DEV_DATABASE_URL_REQUIRED");

describe.sequential("Phase 4D3b-0 capacity admission transaction", () => {
  const database = createDatabase(databaseUrl);
  const repository = new MySqlDerivedAdmissionRepository(database.pool);
  const uploads = new MySqlUploadRepository(database.pool);
  const media = new MySqlMediaRepository(database.pool);
  const suffix = randomUUID().replaceAll("-", "");
  const mediaRoot = mkdtempSync(
    join(realpathSync(tmpdir()), "phase4d3b0-admission-"),
  );
  let storageRoot: StorageRoot;
  let gate: CapacityGate;
  let firstFamily = "";
  let secondFamily = "";
  let userId = "";
  let sessionId = "";
  const sessionHash = randomBytes(32);
  let firstMember = "";
  let secondMember = "";
  const mediaIds: string[] = [];
  const jobIds: string[] = [];

  beforeAll(async () => {
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
        throw new Error("PHASE4D3B0_DEV_PREFLIGHT_FAILED");
      }
      await assertMigrationReadiness(connection);
      await connection.beginTransaction();
      const [one] = await connection.query<ResultSetHeader>(
        "INSERT INTO families (name) VALUES (?)",
        [`D3b0 synthetic A ${suffix}`],
      );
      const [two] = await connection.query<ResultSetHeader>(
        "INSERT INTO families (name) VALUES (?)",
        [`D3b0 synthetic B ${suffix}`],
      );
      firstFamily = String(one.insertId);
      secondFamily = String(two.insertId);
      const username = `d3b0_${suffix}`;
      const [user] = await connection.query<ResultSetHeader>(
        `INSERT INTO users
          (username,username_normalized,password_hash,display_name,password_changed_at)
         VALUES (?,?,?,?,CURRENT_TIMESTAMP(3))`,
        [username, Buffer.from(username), "synthetic-not-used", "D3b0"],
      );
      userId = String(user.insertId);
      const [session] = await connection.query<ResultSetHeader>(
        `INSERT INTO sessions
          (user_id,token_hash,client_type,authenticated_at,last_seen_at,expires_at)
         VALUES (?,?,'WEB',CURRENT_TIMESTAMP(3),CURRENT_TIMESTAMP(3),
           DATE_ADD(CURRENT_TIMESTAMP(3),INTERVAL 30 DAY))`,
        [userId, sessionHash],
      );
      sessionId = String(session.insertId);
      const [memberA] = await connection.query<ResultSetHeader>(
        "INSERT INTO family_members (family_id,user_id,role) VALUES (?,?,'MEMBER')",
        [firstFamily, userId],
      );
      const [memberB] = await connection.query<ResultSetHeader>(
        "INSERT INTO family_members (family_id,user_id,role) VALUES (?,?,'MEMBER')",
        [secondFamily, userId],
      );
      firstMember = String(memberA.insertId);
      secondMember = String(memberB.insertId);
      await connection.commit();
      storageRoot = StorageRoot.open(mediaRoot, { initialize: true });
      storageRoot.provisionSharedCapacityLockForDev();
      gate = CapacityGate.open({
        mediaRoot,
        expectedMarkerId: storageRoot.markerId,
      });
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
  });

  afterEach(async () => {
    if (!firstFamily) return;
    await database.pool.query(
      "DELETE FROM derived_assets WHERE family_id IN (?,?)",
      [firstFamily, secondFamily],
    );
  });

  afterAll(async () => {
    gate?.close();
    storageRoot?.close();
    rmSync(mediaRoot, { recursive: true, force: true });
    const connection = await database.pool.getConnection();
    try {
      await connection.beginTransaction();
      await connection.query(
        "DELETE FROM derived_assets WHERE family_id IN (?,?)",
        [firstFamily, secondFamily],
      );
      await connection.query(
        "DELETE FROM background_jobs WHERE family_id IN (?,?)",
        [firstFamily, secondFamily],
      );
      await connection.query(
        "DELETE FROM media_items WHERE family_id IN (?,?)",
        [firstFamily, secondFamily],
      );
      await connection.query(
        "DELETE FROM upload_sessions WHERE family_id IN (?,?)",
        [firstFamily, secondFamily],
      );
      await connection.query(
        "DELETE FROM storage_objects WHERE family_id IN (?,?)",
        [firstFamily, secondFamily],
      );
      await connection.query("DELETE FROM family_members WHERE user_id=?", [
        userId,
      ]);
      await connection.query("DELETE FROM sessions WHERE id=?", [sessionId]);
      await connection.query("DELETE FROM users WHERE id=?", [userId]);
      await connection.query("DELETE FROM families WHERE id IN (?,?)", [
        firstFamily,
        secondFamily,
      ]);
      await connection.commit();
      const [remaining] = await connection.query<RowDataPacket[]>(
        `SELECT
          (SELECT COUNT(*) FROM derived_assets WHERE family_id IN (?,?)) +
          (SELECT COUNT(*) FROM background_jobs WHERE family_id IN (?,?)) +
          (SELECT COUNT(*) FROM media_items WHERE family_id IN (?,?)) +
          (SELECT COUNT(*) FROM upload_sessions WHERE family_id IN (?,?)) +
          (SELECT COUNT(*) FROM storage_objects WHERE family_id IN (?,?)) +
          (SELECT COUNT(*) FROM families WHERE id IN (?,?)) AS count`,
        [
          firstFamily,
          secondFamily,
          firstFamily,
          secondFamily,
          firstFamily,
          secondFamily,
          firstFamily,
          secondFamily,
          firstFamily,
          secondFamily,
          firstFamily,
          secondFamily,
        ],
      );
      expect(Number(remaining[0]?.count)).toBe(0);
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
      await database.pool.end();
    }
  });

  async function fixture(familyId = firstFamily) {
    const memberId = familyId === firstFamily ? firstMember : secondMember;
    const sha = createHash("sha256").update(randomBytes(16)).digest();
    const [object] = await database.pool.query<ResultSetHeader>(
      `INSERT INTO storage_objects
        (family_id,sha256,byte_size,key_version,state,durable_at,verified_at)
       VALUES (?,?,2048,1,'AVAILABLE',CURRENT_TIMESTAMP(3),CURRENT_TIMESTAMP(3))`,
      [familyId, sha],
    );
    const objectId = String(object.insertId);
    const [upload] = await database.pool.query<ResultSetHeader>(
      `INSERT INTO upload_sessions
        (public_id,family_id,created_by_member_id,original_filename,
         declared_size,committed_offset,state,computed_sha256,
         finalize_started_at,storage_object_id,completed_at,expires_at)
       VALUES (?,?,?,'synthetic.bin',2048,2048,'COMPLETE',?,
         CURRENT_TIMESTAMP(3),?,CURRENT_TIMESTAMP(3),
         DATE_ADD(CURRENT_TIMESTAMP(3),INTERVAL 1 DAY))`,
      [randomBytes(16), familyId, memberId, sha, objectId],
    );
    const created = await media.createOrGetCanonicalMedia({
      familyId,
      uploadId: String(upload.insertId),
    });
    const mediaId = created.media.id;
    mediaIds.push(mediaId);
    const workerId = randomBytes(16);
    const [job] = await database.pool.query<ResultSetHeader>(
      `INSERT INTO background_jobs
        (family_id,media_id,generation,recipe_id,job_type,state,attempts,
         max_attempts,available_at,locked_at,heartbeat_at,locked_until,
         worker_id,lease_epoch)
       VALUES (?,?,1,1,'IMAGE_DERIVATIVES','RUNNING',1,3,
         CURRENT_TIMESTAMP(3),CURRENT_TIMESTAMP(3),CURRENT_TIMESTAMP(3),
         DATE_ADD(CURRENT_TIMESTAMP(3),INTERVAL 90 SECOND),?,1)`,
      [familyId, mediaId, workerId],
    );
    const jobId = String(job.insertId);
    jobIds.push(jobId);
    return {
      familyId,
      mediaId,
      generation: 1n,
      recipeId: 1 as const,
      kind: "THUMBNAIL" as const,
      jobId,
      leaseEpoch: 1n,
      workerId,
    } satisfies DerivedReservationIdentity;
  }

  function snapshot() {
    const physical = gate.snapshotLocked();
    return {
      totalBytes: physical.totalBytes,
      availableBytes: physical.availableBytes,
      complete: physical.derivedInventoryComplete,
      observations: physical.derivedObservations,
    };
  }

  it("uses one physical MySQL connection for session lock and transaction", async () => {
    let innerError: unknown;
    const result = await gate.withAdmissionLock(async (deadline) => {
      try {
        return await runCapacityTransaction(
          database.pool,
          deadline,
          async (connection) => {
            const [rows] = await connection.query<RowDataPacket[]>(
              `SELECT CONNECTION_ID() AS connectionId,
            IS_USED_LOCK(?) AS lockOwner`,
              ["family_album_dev.capacity.v1"],
            );
            return {
              connectionId: String(rows[0]?.connectionId),
              lockOwner: String(rows[0]?.lockOwner),
            };
          },
        );
      } catch (error) {
        innerError = error;
        return null;
      }
    });
    expect(innerError).toBeUndefined();
    expect(result).not.toBeNull();
    if (!result) throw new Error("Capacity transaction failed.");
    expect(result.transaction).toBe("COMMITTED");
    if (result.transaction !== "COMMITTED") {
      throw new Error("Capacity transaction was not committed.");
    }
    expect(result.value.connectionId).toBe(result.value.lockOwner);
    const other = await database.pool.getConnection();
    try {
      const [rows] = await other.query<RowDataPacket[]>(
        "SELECT GET_LOCK(?, 0) AS acquired",
        ["family_album_dev.capacity.v1"],
      );
      expect(String(rows[0]?.acquired)).toBe("1");
      await other.query("SELECT RELEASE_LOCK(?)", [
        "family_album_dev.capacity.v1",
      ]);
    } finally {
      other.release();
    }
  });

  it("admits once, resumes matching same epoch, and rejects forged permits", async () => {
    const identity = await fixture();
    const first = await admitDerivedReservation(
      { state: "READ_WRITE", root: storageRoot },
      gate,
      repository,
      identity,
    );
    expect(first.result.transaction).toBe("COMMITTED");
    expect(first.result.reservation).toBe("CONFIRMED_MATCHING");
    expect(isDerivedTempAdmissionPermit(first.permit)).toBe(true);
    expect(isDerivedTempAdmissionPermit({ ...first.permit })).toBe(false);
    expect(
      () =>
        new DerivedTempAdmissionPermit(
          Symbol("fake") as never,
          identity,
          "1",
          1n,
          performance.now() + 1_000,
        ),
    ).toThrow();
    const again = await admitDerivedReservation(
      { state: "READ_WRITE", root: storageRoot },
      gate,
      repository,
      identity,
    );
    expect(again.result.row?.id).toBe(first.result.row?.id);
    const [rows] = await database.pool.query<RowDataPacket[]>(
      "SELECT COUNT(*) AS count FROM derived_assets WHERE family_id=? AND media_id=?",
      [identity.familyId, identity.mediaId],
    );
    expect(Number(rows[0]?.count)).toBe(1);
  });

  it("retains a confirmed COMMIT that ACKs after the admission deadline", async () => {
    const identity = await fixture();
    const before = readdirSync(mediaRoot).sort();
    const result = await gate.withAdmissionLock(async (deadline) =>
      repository.reserve(identity, deadline, snapshot, {
        commitForTest: async (connection) => {
          await connection.commit();
          await new Promise<void>((resolve) => setTimeout(resolve, 2_100));
        },
      }),
    );
    expect(result.transaction).toBe("COMMITTED");
    expect(result.deadline).toBe("EXCEEDED");
    expect(result.reservation).toBe("CONFIRMED_MATCHING");
    expect(readdirSync(mediaRoot).sort()).toEqual(before);
    const [rows] = await database.pool.query<RowDataPacket[]>(
      "SELECT CAST(reserved_bytes AS CHAR) AS reserved FROM derived_assets WHERE id=?",
      [result.row?.id],
    );
    expect(BigInt(String(rows[0]?.reserved))).toBe(512n * 1_024n);
  });

  it("resolves a real committed but ACK-lost transaction by serialized readback", async () => {
    const identity = await fixture();
    const result = await gate.withAdmissionLock(async (deadline) =>
      repository.reserve(identity, deadline, snapshot, {
        commitForTest: async (connection) => {
          await connection.commit();
          throw new Error("synthetic ACK delivery lost");
        },
      }),
    );
    expect(result.transaction).toBe("UNKNOWN");
    expect(result.reservation).toBe("CONFIRMED_MATCHING");
    expect(result.evidence).toBe("SERIALIZED_READBACK");
    const next = await gate.withAdmissionLock(async (deadline) =>
      repository.reserve(identity, deadline, snapshot),
    );
    expect(next.row?.id).toBe(result.row?.id);
  });

  it("rolls back a reservation when the pre-COMMIT deadline is exceeded", async () => {
    const identity = await fixture();
    const before = readdirSync(mediaRoot).sort();
    const result = await gate.withAdmissionLock(async (deadline) =>
      repository.reserve(identity, deadline, () => {
        const physical = snapshot();
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2_050);
        return physical;
      }),
    );
    expect(result.transaction).toBe("ROLLED_BACK");
    expect(result.reservation).toBe("CONFIRMED_ABSENT");
    expect(result.evidence).toBe("CONFIRMED_ROLLBACK");
    expect(result.deadline).toBe("EXCEEDED");
    expect(readdirSync(mediaRoot).sort()).toEqual(before);
    const [rows] = await database.pool.query<RowDataPacket[]>(
      "SELECT COUNT(*) AS count FROM derived_assets WHERE family_id=? AND media_id=?",
      [identity.familyId, identity.mediaId],
    );
    expect(Number(rows[0]?.count)).toBe(0);
  });

  it("does not claim absence when a timed-out call found a matching prior row", async () => {
    const identity = await fixture();
    const first = await gate.withAdmissionLock(async (deadline) =>
      repository.reserve(identity, deadline, snapshot),
    );
    const second = await gate.withAdmissionLock(async (deadline) =>
      repository.reserve(identity, deadline, () => {
        const physical = snapshot();
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2_050);
        return physical;
      }),
    );
    expect(second.transaction).toBe("ROLLED_BACK");
    expect(second.reservation).toBe("CONFIRMED_MATCHING");
    expect(second.row?.id).toBe(first.row?.id);
    const [rows] = await database.pool.query<RowDataPacket[]>(
      "SELECT COUNT(*) AS count FROM derived_assets WHERE id=?",
      [first.row?.id],
    );
    expect(Number(rows[0]?.count)).toBe(1);
  });

  it("keeps COMMIT unknown unresolved when authoritative readback is unavailable", async () => {
    const identity = await fixture();
    const result = await gate.withAdmissionLock(async (deadline) =>
      repository.reserve(identity, deadline, snapshot, {
        commitForTest: async (connection) => {
          await connection.commit();
          throw new Error("synthetic ACK delivery lost");
        },
        readbackUnavailableForTest: true,
      }),
    );
    expect(result.transaction).toBe("UNKNOWN");
    expect(result.reservation).toBe("UNRESOLVED");
    expect(result.evidence).toBe("NONE");
    const [rows] = await database.pool.query<RowDataPacket[]>(
      "SELECT COUNT(*) AS count FROM derived_assets WHERE family_id=? AND media_id=?",
      [identity.familyId, identity.mediaId],
    );
    expect(Number(rows[0]?.count)).toBe(1);
  });

  it("fails closed when the derived filesystem inventory has an unknown entry", async () => {
    const identity = await fixture();
    const derived = join(mediaRoot, "derived");
    mkdirSync(derived, { mode: 0o700 });
    writeFileSync(join(derived, "unknown-synthetic.bin"), "synthetic");
    try {
      const admission = await admitDerivedReservation(
        { state: "READ_WRITE", root: storageRoot },
        gate,
        repository,
        identity,
      );
      expect(admission.result.transaction).toBe("ROLLED_BACK");
      expect(admission.result.reason).toBe("INVENTORY");
      expect(admission.permit).toBeNull();
    } finally {
      rmSync(derived, { recursive: true });
    }
  });

  it("does not claim confirmed absence after a rollback failure", async () => {
    const identity = await fixture();
    const result = await gate.withAdmissionLock(async (deadline) =>
      repository.reserve(
        identity,
        deadline,
        () => ({ ...snapshot(), complete: false }),
        {
          rollbackForTest: async () => {
            throw new Error("synthetic rollback transport failure");
          },
        },
      ),
    );
    expect(result.transaction).toBe("UNKNOWN");
    expect(result.evidence).toBe("SERIALIZED_READBACK");
    expect(result.reservation).toBe("CONFIRMED_ABSENT");
  });

  it("reaches a finite unknown-outcome budget without late continuation authority", async () => {
    const identity = await fixture();
    let releaseAck!: () => void;
    const heldAck = new Promise<void>((resolve) => {
      releaseAck = resolve;
    });
    const before = readdirSync(mediaRoot).sort();
    const started = performance.now();
    try {
      const result = await gate.withAdmissionLock(async (deadline) =>
        repository.reserve(identity, deadline, snapshot, {
          commitForTest: async (connection) => {
            await connection.commit();
            await heldAck;
          },
        }),
      );
      expect(result.transaction).toBe("UNKNOWN");
      expect(result.reservation).toBe("UNRESOLVED");
      expect(result.evidence).toBe("NONE");
      expect(performance.now() - started).toBeLessThan(8_000);
      expect(readdirSync(mediaRoot).sort()).toEqual(before);
    } finally {
      releaseAck();
    }
  });

  it("does not convert an unrelated duplicate-key error to success", async () => {
    const identity = await fixture();
    const username = `d3b0_${suffix}`;
    await expect(
      gate.withAdmissionLock(async (deadline) =>
        repository.reserve(identity, deadline, snapshot, {
          beforeCommitForTest: async (connection) => {
            await connection.query(
              `INSERT INTO users
                (username,username_normalized,password_hash,password_changed_at)
               VALUES (?,?,?,CURRENT_TIMESTAMP(3))`,
              [username, Buffer.from(username), "synthetic-not-used"],
            );
          },
        }),
      ),
    ).rejects.toThrow();
    const [rows] = await database.pool.query<RowDataPacket[]>(
      "SELECT COUNT(*) AS count FROM derived_assets WHERE family_id=? AND media_id=?",
      [identity.familyId, identity.mediaId],
    );
    expect(Number(rows[0]?.count)).toBe(0);
  });

  it("retries only a confirmed pre-COMMIT deadlock with fresh state", async () => {
    const identity = await fixture();
    let attempts = 0;
    const result = await gate.withAdmissionLock(async (deadline) =>
      repository.reserve(identity, deadline, snapshot, {
        beforeCommitForTest: async () => {
          attempts += 1;
          if (attempts === 1) {
            throw Object.assign(new Error("synthetic deadlock"), {
              code: "ER_LOCK_DEADLOCK",
              errno: 1213,
              sqlState: "40001",
            });
          }
        },
      }),
    );
    expect(attempts).toBe(2);
    expect(result.transaction).toBe("COMMITTED");
    const [rows] = await database.pool.query<RowDataPacket[]>(
      "SELECT COUNT(*) AS count FROM derived_assets WHERE family_id=? AND media_id=?",
      [identity.familyId, identity.mediaId],
    );
    expect(Number(rows[0]?.count)).toBe(1);
  });

  it("releases the MySQL session lock after connection destruction", async () => {
    const first = await database.pool.getConnection();
    const second = await database.pool.getConnection();
    try {
      const [acquired] = await first.query<RowDataPacket[]>(
        "SELECT GET_LOCK(?, 0) AS acquired",
        ["family_album_dev.capacity.v1"],
      );
      expect(String(acquired[0]?.acquired)).toBe("1");
      first.destroy();
      const [next] = await second.query<RowDataPacket[]>(
        "SELECT GET_LOCK(?, 2) AS acquired",
        ["family_album_dev.capacity.v1"],
      );
      expect(String(next[0]?.acquired)).toBe("1");
      await second.query("SELECT RELEASE_LOCK(?)", [
        "family_album_dev.capacity.v1",
      ]);
    } finally {
      first.destroy();
      second.release();
    }
  });

  it("denies cross-family identity and retains a newer-epoch conflict", async () => {
    const identity = await fixture();
    const cross = await gate.withAdmissionLock(async (deadline) =>
      repository.reserve(
        { ...identity, familyId: secondFamily },
        deadline,
        snapshot,
      ),
    );
    expect(cross.reservation).not.toBe("CONFIRMED_MATCHING");
    await gate.withAdmissionLock(async (deadline) =>
      repository.reserve(identity, deadline, snapshot),
    );
    await database.pool.query(
      `UPDATE background_jobs SET lease_epoch=2,
        locked_until=DATE_ADD(CURRENT_TIMESTAMP(3),INTERVAL 90 SECOND)
       WHERE id=?`,
      [identity.jobId],
    );
    const newer = await gate.withAdmissionLock(async (deadline) =>
      repository.reserve({ ...identity, leaseEpoch: 2n }, deadline, snapshot),
    );
    expect(newer.reservation).toBe("CONFLICTING");
  });

  it("serializes different families against one global physical capacity", async () => {
    const a = await fixture(firstFamily);
    const b = await fixture(secondFamily);
    const cap = 512n * 1_024n;
    const reserve = 10n * 1_024n ** 3n;
    const available = reserve + 64n * 1_024n ** 2n + 2n * cap - 1n;
    const admitted = async (identity: DerivedReservationIdentity) =>
      gate.withAdmissionLock(async (deadline) =>
        repository.reserve(identity, deadline, () => ({
          totalBytes: 100n * 1_024n ** 3n,
          availableBytes: available,
          complete: true,
          observations: [],
        })),
      );
    const results = await Promise.all([admitted(a), admitted(b)]);
    expect(
      results.filter((result) => result.transaction === "COMMITTED"),
    ).toHaveLength(1);
    expect(
      results.filter((result) => result.reason === "CAPACITY"),
    ).toHaveLength(1);
  });

  it("serializes two real processes from different families at the OS/DB barrier", async () => {
    const a = await fixture(firstFamily);
    const b = await fixture(secondFamily);
    let signalCommit!: () => void;
    const committed = new Promise<void>((resolve) => {
      signalCommit = resolve;
    });
    let releaseCommit!: () => void;
    const holdAck = new Promise<void>((resolve) => {
      releaseCommit = resolve;
    });
    const available =
      10n * 1_024n ** 3n + 64n * 1_024n ** 2n + 2n * 512n * 1_024n - 1n;
    const parent = gate.withAdmissionLock(async (deadline) =>
      repository.reserve(
        a,
        deadline,
        () => ({
          totalBytes: 100n * 1_024n ** 3n,
          availableBytes: available,
          complete: snapshot().complete,
          observations: snapshot().observations,
        }),
        {
          commitForTest: async (connection) => {
            await connection.commit();
            signalCommit();
            await holdAck;
          },
        },
      ),
    );
    await committed;
    const child = fork(
      new URL("./fixtures/capacity-admission-child.mjs", import.meta.url),
      {
        execArgv: ["--import", "tsx"],
        stdio: ["ignore", "ignore", "ignore", "ipc"],
      },
    );
    const childResult = new Promise<{
      stage: string;
      transaction?: string;
      reason?: string | null;
    }>((resolve, reject) => {
      let observedOsBusy = false;
      const timeout = setTimeout(() => {
        releaseCommit();
        child.kill();
        reject(new Error("Synthetic capacity child timed out."));
      }, 8_000);
      child.on("message", (message: unknown) => {
        if (!message || typeof message !== "object") return;
        const stage = (message as { stage?: string }).stage;
        if (stage === "os-busy") {
          observedOsBusy = true;
          releaseCommit();
        }
        if (stage === "done" || stage === "failed") {
          clearTimeout(timeout);
          if (!observedOsBusy) {
            reject(new Error("Child did not observe a busy OS capacity lock."));
            return;
          }
          resolve(
            message as {
              stage: string;
              transaction?: string;
              reason?: string | null;
            },
          );
        }
      });
      child.on("error", (error) => {
        releaseCommit();
        clearTimeout(timeout);
        reject(error);
      });
      child.on("exit", (code) => {
        if (code !== 0) {
          releaseCommit();
          clearTimeout(timeout);
          reject(new Error(`Synthetic capacity child exited ${code}.`));
        }
      });
    });
    child.send({
      mediaRoot,
      markerId: storageRoot.markerId,
      identity: {
        ...b,
        generation: b.generation.toString(),
        leaseEpoch: b.leaseEpoch.toString(),
        workerId: b.workerId.toString("base64url"),
      },
    });
    const [aResult, bResult] = await Promise.all([parent, childResult]);
    expect(aResult.transaction).toBe("COMMITTED");
    expect(bResult.stage).toBe("done");
    expect(bResult.transaction).toBe("ROLLED_BACK");
    expect(bResult.reason).toBe("CAPACITY");
  });

  it("routes Phase 3 upload creation through the same OS and DB capacity barriers", async () => {
    const service = new UploadService(
      uploads,
      { state: "READ_WRITE", root: storageRoot },
      gate,
    );
    const now = new Date();
    const context = {
      identity: {
        sessionId,
        userId,
        username: `d3b0_${suffix}`,
        displayName: "D3b0",
        passwordHash: "synthetic-not-used",
        clientType: "WEB",
        authenticatedAt: now,
        createdAt: now,
        lastSeenAt: now,
        expiresAt: new Date(now.getTime() + 30 * 24 * 60 * 60_000),
        revokedAt: null,
        disabledAt: null,
        serverNow: now,
      },
      tokenHash: sessionHash,
    } satisfies AuthContext;
    const publicId = randomBytes(16);
    const upload = await service.create(context, {
      familyId: firstFamily,
      publicId,
      declaredSize: 2048n,
      filename: "synthetic-upload.bin",
      reportedMime: "application/octet-stream",
    });
    expect(upload.familyId).toBe(firstFamily);
    const [rows] = await database.pool.query<RowDataPacket[]>(
      "SELECT state FROM upload_sessions WHERE public_id=? AND family_id=?",
      [publicId, firstFamily],
    );
    expect(rows[0]?.state).toBe("CREATED");
    const other = await database.pool.getConnection();
    try {
      const [lock] = await other.query<RowDataPacket[]>(
        "SELECT GET_LOCK(?,0) AS acquired",
        ["family_album_dev.capacity.v1"],
      );
      expect(String(lock[0]?.acquired)).toBe("1");
      await other.query("SELECT RELEASE_LOCK(?)", [
        "family_album_dev.capacity.v1",
      ]);
    } finally {
      other.release();
    }
  });

  it("does not create an upload receipt when another process owns the DB barrier", async () => {
    const holder = await database.pool.getConnection();
    const publicId = randomBytes(16);
    try {
      const [owned] = await holder.query<RowDataPacket[]>(
        "SELECT GET_LOCK(?, 0) AS acquired",
        ["family_album_dev.capacity.v1"],
      );
      expect(String(owned[0]?.acquired)).toBe("1");
      await expect(
        gate.withAdmissionLock(async (deadline, snapshot) =>
          uploads.createUploadCapacityAdmitted(
            {
              actor: { userId, sessionId, tokenHash: sessionHash },
              familyId: firstFamily,
              publicId,
              originalFilename: "blocked-synthetic.bin",
              reportedMime: null,
              declaredSize: 2048n,
            },
            deadline,
            snapshot,
          ),
        ),
      ).rejects.toThrow();
      const [rows] = await database.pool.query<RowDataPacket[]>(
        "SELECT COUNT(*) AS count FROM upload_sessions WHERE public_id=?",
        [publicId],
      );
      expect(Number(rows[0]?.count)).toBe(0);
    } finally {
      await holder.query("SELECT RELEASE_LOCK(?)", [
        "family_album_dev.capacity.v1",
      ]);
      holder.release();
    }
  });

  function writeKnownPart(
    jobId: string,
    epoch: string,
    filename: "thumbnail.part" | "preview.part",
    contents = "tiny",
  ) {
    const derived = join(mediaRoot, "derived");
    const temp = join(derived, ".tmp");
    const job = join(temp, jobId);
    const epochDirectory = join(job, `e${epoch}`);
    mkdirSync(epochDirectory, { recursive: true });
    for (const directory of [derived, temp, job, epochDirectory]) {
      chmodSync(directory, 0o700);
    }
    const file = join(epochDirectory, filename);
    writeFileSync(file, contents);
    chmodSync(file, 0o600);
  }

  it("correlates a known temp with its reservation and charges reserved bytes", async () => {
    const identity = await fixture();
    const created = await gate.withAdmissionLock(async (deadline) =>
      repository.reserve(identity, deadline, snapshot),
    );
    expect(created.transaction).toBe("COMMITTED");
    writeKnownPart(identity.jobId, "1", "thumbnail.part");
    try {
      const reused = await gate.withAdmissionLock(async (deadline) =>
        repository.reserve(identity, deadline, snapshot),
      );
      expect(reused.transaction).toBe("COMMITTED");
      expect(reused.row?.reservedBytes).toBe(512n * 1024n);
      const [stored] = await database.pool.query<RowDataPacket[]>(
        `SELECT CAST(reserved_bytes AS CHAR) AS reservedBytes, byte_size AS byteSize
         FROM derived_assets WHERE id=?`,
        [reused.row?.id],
      );
      expect(stored[0]?.reservedBytes).toBe("524288");
      expect(stored[0]?.byteSize).toBeNull();
      await gate.withAdmissionLock(async (deadline) => {
        await runCapacityTransaction(
          database.pool,
          deadline,
          async (connection) => {
            const correlated = await correlateDerivedFilesystemInventory(
              connection,
              snapshot().observations,
            );
            expect(correlated.complete).toBe(true);
            expect(correlated.matches[0]).toMatchObject({
              familyId: identity.familyId,
              mediaId: identity.mediaId,
              generation: 1n,
              recipeId: 1,
              kind: "THUMBNAIL",
              producerJobId: identity.jobId,
              epoch: 1n,
              reservedBytes: 512n * 1024n,
              state: "RESERVED",
              cleanedAt: null,
              observedBytes: 4n,
            });
            return correlated;
          },
        );
      });
    } finally {
      rmSync(join(mediaRoot, "derived"), { recursive: true, force: true });
    }
  });

  it("fails closed when a known temp has no reservation row", async () => {
    const identity = await fixture();
    writeKnownPart(identity.jobId, "1", "thumbnail.part");
    try {
      const admission = await admitDerivedReservation(
        { state: "READ_WRITE", root: storageRoot },
        gate,
        repository,
        identity,
      );
      expect(admission.permit).toBeNull();
      expect(admission.result.transaction).toBe("ROLLED_BACK");
      expect(admission.result.reason).toBe("INVENTORY");
      const [rows] = await database.pool.query<RowDataPacket[]>(
        "SELECT COUNT(*) AS count FROM derived_assets WHERE producer_job_id=?",
        [identity.jobId],
      );
      expect(Number(rows[0]?.count)).toBe(0);
    } finally {
      rmSync(join(mediaRoot, "derived"), { recursive: true, force: true });
    }
  });

  it("fails closed when the temp epoch does not match the reservation", async () => {
    const identity = await fixture();
    const created = await gate.withAdmissionLock(async (deadline) =>
      repository.reserve(identity, deadline, snapshot),
    );
    expect(created.transaction).toBe("COMMITTED");
    writeKnownPart(identity.jobId, "2", "thumbnail.part");
    try {
      const admission = await admitDerivedReservation(
        { state: "READ_WRITE", root: storageRoot },
        gate,
        repository,
        identity,
      );
      expect(admission.permit).toBeNull();
      expect(admission.result.reason).toBe("INVENTORY");
    } finally {
      rmSync(join(mediaRoot, "derived"), { recursive: true, force: true });
    }
  });

  it("fails closed when the temp kind does not match the reservation", async () => {
    const identity = await fixture();
    const created = await gate.withAdmissionLock(async (deadline) =>
      repository.reserve(identity, deadline, snapshot),
    );
    expect(created.transaction).toBe("COMMITTED");
    writeKnownPart(identity.jobId, "1", "preview.part");
    try {
      const admission = await admitDerivedReservation(
        { state: "READ_WRITE", root: storageRoot },
        gate,
        repository,
        identity,
      );
      expect(admission.permit).toBeNull();
      expect(admission.result.reason).toBe("INVENTORY");
    } finally {
      rmSync(join(mediaRoot, "derived"), { recursive: true, force: true });
    }
  });

  it("fails closed when a cleaned reservation still has a temp file", async () => {
    const identity = await fixture();
    const created = await gate.withAdmissionLock(async (deadline) =>
      repository.reserve(identity, deadline, snapshot),
    );
    expect(created.transaction).toBe("COMMITTED");
    writeKnownPart(identity.jobId, "1", "thumbnail.part");
    await database.pool.query(
      "UPDATE derived_assets SET cleaned_at=CURRENT_TIMESTAMP(3) WHERE id=?",
      [created.row?.id],
    );
    try {
      const admission = await admitDerivedReservation(
        { state: "READ_WRITE", root: storageRoot },
        gate,
        repository,
        identity,
      );
      expect(admission.permit).toBeNull();
      expect(admission.result.transaction).not.toBe("COMMITTED");
      await gate.withAdmissionLock(async (deadline) => {
        await runCapacityTransaction(
          database.pool,
          deadline,
          async (connection) => {
            const correlated = await correlateDerivedFilesystemInventory(
              connection,
              snapshot().observations,
            );
            expect(correlated.complete).toBe(false);
            expect(correlated.matches).toEqual([]);
            return correlated;
          },
        );
      });
    } finally {
      rmSync(join(mediaRoot, "derived"), { recursive: true, force: true });
    }
  });

  it("fails closed when reservation correlation cannot read the database", async () => {
    const connection = await database.pool.getConnection();
    connection.destroy();
    await expect(
      correlateDerivedFilesystemInventory(connection, [
        {
          jobId: "1",
          epoch: 1n,
          kind: "THUMBNAIL",
          byteSize: 1n,
          device: "1",
          inode: "1",
        },
      ]),
    ).rejects.toThrow();
  });
});
