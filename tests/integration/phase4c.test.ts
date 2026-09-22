import { createHash, randomBytes, randomUUID } from "node:crypto";

import type { ResultSetHeader, RowDataPacket } from "mysql2/promise";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import {
  assertMigrationReadiness,
  createDatabase,
  JobRepositoryError,
  MySqlJobRepository,
  MySqlMediaRepository,
  type BackgroundJobRecord,
  type LeaseFence,
} from "../../packages/db/dist/index.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("PHASE4C_DEV_DATABASE_URL_REQUIRED");

describe.sequential("Phase 4C MySQL job claim and epoch fencing", () => {
  const database = createDatabase(databaseUrl);
  const jobs = new MySqlJobRepository(database.pool, { random: () => 0 });
  const media = new MySqlMediaRepository(database.pool);
  const suffix = randomUUID().replaceAll("-", "");
  let familyId = "";
  let crossFamilyId = "";
  let memberId = "";

  beforeAll(async () => {
    const connection = await database.pool.getConnection();
    try {
      await connection.query("SET SESSION time_zone = '+00:00'");
      const [preflight] = await connection.query<RowDataPacket[]>(
        `SELECT DATABASE() AS db, VERSION() AS mysqlVersion,
          CURRENT_USER() AS account,
          @@GLOBAL.innodb_native_foreign_keys AS nativeFk,
          @@SESSION.foreign_key_checks AS foreignKeyChecks`,
      );
      const ready = preflight[0];
      if (
        !ready ||
        ready.db !== "family_album_dev" ||
        !String(ready.mysqlVersion).startsWith("9.7.2") ||
        String(ready.account).split("@")[0]?.toLowerCase() === "root" ||
        Number(ready.nativeFk) !== 1 ||
        Number(ready.foreignKeyChecks) !== 1
      ) {
        throw new Error("PHASE4C_DEV_PREFLIGHT_FAILED");
      }
      await assertMigrationReadiness(connection);
      await connection.beginTransaction();
      const [family] = await connection.query<ResultSetHeader>(
        "INSERT INTO families (name) VALUES (?)",
        [`Phase 4C synthetic ${suffix}`],
      );
      familyId = String(family.insertId);
      const [crossFamily] = await connection.query<ResultSetHeader>(
        "INSERT INTO families (name) VALUES (?)",
        [`Phase 4C cross synthetic ${suffix}`],
      );
      crossFamilyId = String(crossFamily.insertId);
      const username = `phase4c_${suffix}`;
      const [user] = await connection.query<ResultSetHeader>(
        `INSERT INTO users
          (username,username_normalized,password_hash,display_name,password_changed_at)
         VALUES (?,?,?,?,CURRENT_TIMESTAMP(3))`,
        [username, Buffer.from(username), "synthetic-not-used", "Phase 4C"],
      );
      const [member] = await connection.query<ResultSetHeader>(
        "INSERT INTO family_members (family_id,user_id,role) VALUES (?,?,'MEMBER')",
        [familyId, String(user.insertId)],
      );
      memberId = String(member.insertId);
      await connection.commit();
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
  });

  afterEach(async () => {
    if (!familyId) return;
    await database.pool.query(
      `UPDATE background_jobs
       SET state='CANCELLED',worker_id=NULL,locked_at=NULL,heartbeat_at=NULL,
         locked_until=NULL,last_failure_code=NULL,finished_at=CURRENT_TIMESTAMP(3)
       WHERE family_id=? AND state NOT IN ('SUCCEEDED','FAILED','CANCELLED')`,
      [familyId],
    );
  });

  afterAll(async () => {
    const connection = await database.pool.getConnection();
    try {
      await connection.query("SET SESSION time_zone = '+00:00'");
      await connection.beginTransaction();
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
      await connection.query(
        "DELETE FROM family_members WHERE family_id IN (?,?)",
        [familyId, crossFamilyId],
      );
      await connection.query("DELETE FROM users WHERE username=?", [
        `phase4c_${suffix}`,
      ]);
      await connection.query("DELETE FROM families WHERE id IN (?,?)", [
        familyId,
        crossFamilyId,
      ]);
      await connection.commit();
      const [remaining] = await connection.query<RowDataPacket[]>(
        `SELECT
          (SELECT COUNT(*) FROM background_jobs WHERE family_id=?) +
          (SELECT COUNT(*) FROM media_items WHERE family_id=?) +
          (SELECT COUNT(*) FROM upload_sessions WHERE family_id=?) +
          (SELECT COUNT(*) FROM storage_objects WHERE family_id=?) AS count`,
        [familyId, familyId, familyId, familyId],
      );
      expect(Number(remaining[0]?.count ?? 1)).toBe(0);
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
      await database.pool.end();
    }
  });

  async function createMedia(label: string) {
    const sha256 = createHash("sha256").update(`${suffix}:${label}`).digest();
    const byteSize = BigInt(2048 + label.length);
    const [object] = await database.pool.query<ResultSetHeader>(
      `INSERT INTO storage_objects
        (family_id,sha256,byte_size,key_version,state,durable_at,verified_at)
       VALUES (?,?,?,1,'AVAILABLE',CURRENT_TIMESTAMP(3),CURRENT_TIMESTAMP(3))`,
      [familyId, sha256, byteSize.toString()],
    );
    const objectId = String(object.insertId);
    const [upload] = await database.pool.query<ResultSetHeader>(
      `INSERT INTO upload_sessions
        (public_id,family_id,created_by_member_id,original_filename,
         declared_size,committed_offset,state,computed_sha256,
         finalize_started_at,storage_object_id,completed_at,expires_at)
       VALUES (?,?,?,'synthetic.bin',?,?,'COMPLETE',?,CURRENT_TIMESTAMP(3),?,
         CURRENT_TIMESTAMP(3),DATE_ADD(CURRENT_TIMESTAMP(3),INTERVAL 1 DAY))`,
      [
        randomBytes(16),
        familyId,
        memberId,
        byteSize.toString(),
        byteSize.toString(),
        sha256,
        objectId,
      ],
    );
    return (
      await media.createOrGetCanonicalMedia({
        familyId,
        uploadId: String(upload.insertId),
      })
    ).media;
  }

  async function enqueue(mediaId: string, generation = 1n) {
    return jobs.enqueue({
      familyId,
      mediaId,
      generation,
      recipeId: 1,
      jobType: "MEDIA_PROBE",
    });
  }

  function fence(job: BackgroundJobRecord): LeaseFence {
    if (!job.workerId) throw new Error("expected claimed worker");
    return {
      familyId: job.familyId,
      mediaId: job.mediaId,
      jobId: job.id,
      generation: job.generation,
      workerId: job.workerId,
      leaseEpoch: job.leaseEpoch,
    };
  }

  async function expire(jobId: string) {
    await database.pool.query(
      `UPDATE background_jobs SET locked_at=DATE_SUB(CURRENT_TIMESTAMP(3),INTERVAL 120 SECOND),
        heartbeat_at=DATE_SUB(CURRENT_TIMESTAMP(3),INTERVAL 120 SECOND),
        locked_until=DATE_SUB(CURRENT_TIMESTAMP(3),INTERVAL 1 SECOND)
       WHERE id=? AND state='RUNNING'`,
      [jobId],
    );
  }

  async function makeRetryAvailable(jobId: string) {
    await database.pool.query(
      `UPDATE background_jobs SET available_at=DATE_SUB(CURRENT_TIMESTAMP(3),INTERVAL 1 SECOND)
       WHERE id=? AND state='RETRY_WAIT'`,
      [jobId],
    );
  }

  async function retire(jobIds: string[]) {
    if (jobIds.length === 0) return;
    await database.pool.query(
      `UPDATE background_jobs
       SET state='CANCELLED',worker_id=NULL,locked_at=NULL,heartbeat_at=NULL,
         locked_until=NULL,last_failure_code=NULL,finished_at=CURRENT_TIMESTAMP(3)
       WHERE id IN (${jobIds.map(() => "?").join(",")})
         AND state NOT IN ('SUCCEEDED','FAILED','CANCELLED')`,
      jobIds,
    );
  }

  it("deduplicates one generation and preserves history across generation+1", async () => {
    const item = await createMedia("generation-identity");
    const first = await enqueue(item.id);
    const duplicate = await enqueue(item.id);
    expect(first.created).toBe(true);
    expect(duplicate.created).toBe(false);
    expect(duplicate.job.id).toBe(first.job.id);

    await database.pool.query(
      "UPDATE media_items SET generation=2 WHERE id=? AND family_id=?",
      [item.id, familyId],
    );
    const next = await enqueue(item.id, 2n);
    expect(next.created).toBe(true);
    expect(next.job.id).not.toBe(first.job.id);
    const [rows] = await database.pool.query<RowDataPacket[]>(
      "SELECT generation FROM background_jobs WHERE media_id=? ORDER BY generation",
      [item.id],
    );
    expect(rows.map((row) => String(row.generation))).toEqual(["1", "2"]);
    await expect(
      jobs.enqueue({
        familyId: crossFamilyId,
        mediaId: item.id,
        generation: 2n,
        recipeId: 1,
        jobType: "MEDIA_PROBE",
      }),
    ).rejects.toBeInstanceOf(JobRepositoryError);
    await retire([first.job.id, next.job.id]);
  });

  it("uses the claim index and SKIP LOCKED to give two workers different jobs", async () => {
    const firstMedia = await createMedia("skip-locked-a");
    const secondMedia = await createMedia("skip-locked-b");
    const firstJob = (await enqueue(firstMedia.id)).job;
    const secondJob = (await enqueue(secondMedia.id)).job;
    const blocker = await database.pool.getConnection();
    try {
      await blocker.query("SET SESSION time_zone = '+00:00'");
      await blocker.beginTransaction();
      const [locked] = await blocker.query<RowDataPacket[]>(
        "SELECT id FROM background_jobs WHERE id=? FOR UPDATE",
        [firstJob.id],
      );
      const lockedId = String(locked[0]?.id);
      expect(lockedId).toBe(firstJob.id);
      const workerB = MySqlJobRepository.createWorkerIdentity();
      const claimedB = await jobs.claimNext(workerB);
      expect(claimedB).not.toBeNull();
      expect(claimedB?.id).toBe(secondJob.id);
      await blocker.rollback();
      const claimedA = await jobs.claimNext(
        MySqlJobRepository.createWorkerIdentity(),
      );
      expect(claimedA?.id).toBe(lockedId);

      const [plan] = await database.pool.query<RowDataPacket[]>(
        `EXPLAIN SELECT id FROM background_jobs FORCE INDEX (idx_background_jobs_claim)
         WHERE state IN ('QUEUED','RETRY_WAIT') AND available_at<=CURRENT_TIMESTAMP(3)
           AND attempts<max_attempts ORDER BY available_at,id LIMIT 1 FOR UPDATE SKIP LOCKED`,
      );
      expect(String(plan[0]?.EXPLAIN)).toContain(
        "using idx_background_jobs_claim",
      );
      await retire([firstJob.id, secondJob.id]);
    } finally {
      if ((blocker as unknown as { _closing?: boolean })._closing !== true) {
        await blocker.rollback().catch(() => undefined);
      }
      blocker.release();
    }
  });

  it("never double-claims one eligible job across real concurrent calls", async () => {
    const item = await createMedia("concurrent-claim");
    const queued = (await enqueue(item.id)).job;
    const [left, right] = await Promise.all([
      jobs.claimNext(MySqlJobRepository.createWorkerIdentity()),
      new MySqlJobRepository(database.pool).claimNext(
        MySqlJobRepository.createWorkerIdentity(),
      ),
    ]);
    expect(
      [left, right].filter((value) => value?.id === queued.id),
    ).toHaveLength(1);
    expect([left, right].filter((value) => value === null)).toHaveLength(1);
    await retire([queued.id]);
  });

  it("advances epoch on reclaim and fences every stale worker mutation", async () => {
    const item = await createMedia("epoch-fence");
    const queued = (await enqueue(item.id)).job;
    const workerA = MySqlJobRepository.createWorkerIdentity();
    const claimedA = await jobs.claimNext(workerA);
    expect(claimedA?.id).toBe(queued.id);
    const fenceA = fence(claimedA!);
    expect((await jobs.heartbeat(fenceA)).affectedRows).toBe(1);
    expect(
      (await jobs.complete({ ...fenceA, familyId: crossFamilyId }))
        .affectedRows,
    ).toBe(0);
    expect(
      (
        await jobs.recoverExpiredLease({
          familyId,
          mediaId: item.id,
          jobId: queued.id,
          generation: 1n,
        })
      ).affectedRows,
    ).toBe(0);

    await expire(queued.id);
    expect(
      await jobs.recoverExpiredLease({
        familyId,
        mediaId: item.id,
        jobId: queued.id,
        generation: 1n,
      }),
    ).toMatchObject({ affectedRows: 1, state: "RETRY_WAIT" });
    await makeRetryAvailable(queued.id);
    const claimedB = await jobs.claimNext(
      MySqlJobRepository.createWorkerIdentity(),
    );
    expect(claimedB?.id).toBe(queued.id);
    expect(claimedB?.leaseEpoch).toBe(fenceA.leaseEpoch + 1n);

    expect((await jobs.heartbeat(fenceA)).affectedRows).toBe(0);
    expect((await jobs.complete(fenceA)).affectedRows).toBe(0);
    expect(
      (await jobs.fail({ ...fenceA, failureCode: "MALFORMED_MEDIA" }))
        .affectedRows,
    ).toBe(0);
    expect(
      (await jobs.retry({ ...fenceA, failureCode: "TEMPORARY_IO" }))
        .affectedRows,
    ).toBe(0);
    expect((await jobs.complete(fence(claimedB!))).affectedRows).toBe(1);
  });

  it("supports current retry/failure and enforces the three-attempt ceiling", async () => {
    const retryMedia = await createMedia("current-retry");
    const retryJob = (await enqueue(retryMedia.id)).job;
    const first = await jobs.claimNext(
      MySqlJobRepository.createWorkerIdentity(),
    );
    expect(first?.id).toBe(retryJob.id);
    expect(
      await jobs.retry({ ...fence(first!), failureCode: "TEMPORARY_IO" }),
    ).toMatchObject({ affectedRows: 1, state: "RETRY_WAIT" });
    await makeRetryAvailable(retryJob.id);
    const second = await jobs.claimNext(
      MySqlJobRepository.createWorkerIdentity(),
    );
    expect(second?.leaseEpoch).toBe(2n);
    expect(
      await jobs.fail({ ...fence(second!), failureCode: "MALFORMED_MEDIA" }),
    ).toMatchObject({ affectedRows: 1, state: "FAILED" });

    const maxMedia = await createMedia("max-attempts");
    const maxJob = (await enqueue(maxMedia.id)).job;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const claimed = await jobs.claimNext(
        MySqlJobRepository.createWorkerIdentity(),
      );
      expect(claimed?.id).toBe(maxJob.id);
      expect(claimed?.attempts).toBe(attempt);
      expect(claimed?.leaseEpoch).toBe(BigInt(attempt));
      await expire(maxJob.id);
      const recovered = await jobs.recoverExpiredLease({
        familyId,
        mediaId: maxMedia.id,
        jobId: maxJob.id,
        generation: 1n,
      });
      expect(recovered.affectedRows).toBe(1);
      expect(recovered.state).toBe(attempt === 3 ? "FAILED" : "RETRY_WAIT");
      if (attempt < 3) await makeRetryAvailable(maxJob.id);
    }
    const [rows] = await database.pool.query<RowDataPacket[]>(
      "SELECT state,attempts,lease_epoch AS leaseEpoch FROM background_jobs WHERE id=?",
      [maxJob.id],
    );
    expect(rows[0]).toMatchObject({
      state: "FAILED",
      attempts: 3,
      leaseEpoch: "3",
    });
  });
});
