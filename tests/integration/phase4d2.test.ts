import { createHash, randomBytes, randomUUID } from "node:crypto";

import type { NormalizedMetadataResult } from "@family-album/media";
import type { ResultSetHeader, RowDataPacket } from "mysql2/promise";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import {
  assertMigrationReadiness,
  createDatabase,
  type LeaseFence,
  MetadataRepositoryError,
  MySqlJobRepository,
  MySqlMediaRepository,
  MySqlMetadataRepository,
} from "../../packages/db/dist/index.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("PHASE4D2_DEV_DATABASE_URL_REQUIRED");

describe.sequential("Phase 4D2 metadata persistence fencing", () => {
  const database = createDatabase(databaseUrl);
  const jobs = new MySqlJobRepository(database.pool, { random: () => 0 });
  const media = new MySqlMediaRepository(database.pool);
  const metadata = new MySqlMetadataRepository(database.pool, {
    random: () => 0,
  });
  const suffix = randomUUID().replaceAll("-", "");
  let familyId = "";
  let crossFamilyId = "";
  let memberId = "";

  beforeAll(async () => {
    const connection = await database.pool.getConnection();
    try {
      await connection.query("SET SESSION time_zone = '+00:00'");
      const [preflight] = await connection.query<RowDataPacket[]>(
        `SELECT DATABASE() AS db,VERSION() AS mysqlVersion,CURRENT_USER() AS account,
          @@GLOBAL.innodb_native_foreign_keys AS nativeFk,
          @@SESSION.foreign_key_checks AS foreignKeyChecks`,
      );
      const row = preflight[0];
      if (
        !row ||
        row.db !== "family_album_dev" ||
        !String(row.mysqlVersion).startsWith("9.7.2") ||
        String(row.account).split("@")[0]?.toLowerCase() === "root" ||
        Number(row.nativeFk) !== 1 ||
        Number(row.foreignKeyChecks) !== 1
      ) {
        throw new Error("PHASE4D2_DEV_PREFLIGHT_FAILED");
      }
      await assertMigrationReadiness(connection);
      await connection.beginTransaction();
      const [family] = await connection.query<ResultSetHeader>(
        "INSERT INTO families (name) VALUES (?)",
        [`Phase 4D2 synthetic ${suffix}`],
      );
      familyId = String(family.insertId);
      const [cross] = await connection.query<ResultSetHeader>(
        "INSERT INTO families (name) VALUES (?)",
        [`Phase 4D2 cross synthetic ${suffix}`],
      );
      crossFamilyId = String(cross.insertId);
      const username = `phase4d2_${suffix}`;
      const [user] = await connection.query<ResultSetHeader>(
        `INSERT INTO users
          (username,username_normalized,password_hash,display_name,password_changed_at)
         VALUES (?,?,?,?,CURRENT_TIMESTAMP(3))`,
        [username, Buffer.from(username), "synthetic-not-used", "Phase 4D2"],
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
      `UPDATE background_jobs SET state='CANCELLED',worker_id=NULL,
        locked_at=NULL,heartbeat_at=NULL,locked_until=NULL,last_failure_code=NULL,
        finished_at=CURRENT_TIMESTAMP(3)
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
        `phase4d2_${suffix}`,
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

  async function createClaimed(label: string, generation = 1n) {
    const sha256 = createHash("sha256").update(`${suffix}:${label}`).digest();
    const bytes = BigInt(4096 + label.length);
    const [object] = await database.pool.query<ResultSetHeader>(
      `INSERT INTO storage_objects
        (family_id,sha256,byte_size,key_version,state,durable_at,verified_at)
       VALUES (?,?,?,1,'AVAILABLE',CURRENT_TIMESTAMP(3),CURRENT_TIMESTAMP(3))`,
      [familyId, sha256, bytes.toString()],
    );
    const storageObjectId = String(object.insertId);
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
        bytes.toString(),
        bytes.toString(),
        sha256,
        storageObjectId,
      ],
    );
    const item = (
      await media.createOrGetCanonicalMedia({
        familyId,
        uploadId: String(upload.insertId),
      })
    ).media;
    if (generation !== 1n) {
      await database.pool.query(
        "UPDATE media_items SET generation=?,processing_state='PENDING' WHERE id=?",
        [generation.toString(), item.id],
      );
    }
    const claimed = await insertClaimedJob(item.id, generation);
    const preparation = await metadata.prepare(claimed.fence);
    if (!preparation) throw new Error("expected current synthetic lease");
    return {
      item,
      uploadId: String(upload.insertId),
      storageObjectId,
      claimed,
      fence: claimed.fence,
      preparation,
    };
  }

  async function insertClaimedJob(mediaId: string, generation: bigint) {
    const workerId = MySqlJobRepository.createWorkerIdentity();
    const [inserted] = await database.pool.query<ResultSetHeader>(
      `INSERT INTO background_jobs
        (family_id,media_id,generation,recipe_id,job_type,state,attempts,
         available_at,locked_at,heartbeat_at,locked_until,worker_id,lease_epoch)
       VALUES (?,?,?,1,'MEDIA_PROBE','RUNNING',1,CURRENT_TIMESTAMP(3),
         CURRENT_TIMESTAMP(3),CURRENT_TIMESTAMP(3),
         DATE_ADD(CURRENT_TIMESTAMP(3),INTERVAL 90 SECOND),?,1)`,
      [familyId, mediaId, generation.toString(), workerId],
    );
    const id = String(inserted.insertId);
    return {
      id,
      leaseEpoch: 1n,
      fence: {
        familyId,
        mediaId,
        jobId: id,
        generation,
        workerId,
        leaseEpoch: 1n,
      } satisfies LeaseFence,
    };
  }

  async function reclaimDirect(input: {
    jobId: string;
    mediaId: string;
    generation: bigint;
    expectedEpoch: bigint;
  }) {
    const workerId = MySqlJobRepository.createWorkerIdentity();
    const [changed] = await database.pool.query<ResultSetHeader>(
      `UPDATE background_jobs SET state='RUNNING',attempts=attempts+1,
        worker_id=?,lease_epoch=lease_epoch+1,locked_at=CURRENT_TIMESTAMP(3),
        heartbeat_at=CURRENT_TIMESTAMP(3),
        locked_until=DATE_ADD(CURRENT_TIMESTAMP(3),INTERVAL 90 SECOND),
        last_failure_code=NULL,finished_at=NULL,updated_at=CURRENT_TIMESTAMP(3)
       WHERE id=? AND family_id=? AND media_id=? AND generation=?
         AND state='RETRY_WAIT' AND lease_epoch=?`,
      [
        workerId,
        input.jobId,
        familyId,
        input.mediaId,
        input.generation.toString(),
        input.expectedEpoch.toString(),
      ],
    );
    expect(changed.affectedRows).toBe(1);
    return {
      familyId,
      mediaId: input.mediaId,
      jobId: input.jobId,
      generation: input.generation,
      workerId,
      leaseEpoch: input.expectedEpoch + 1n,
    } satisfies LeaseFence;
  }

  async function expire(jobId: string) {
    await database.pool.query(
      `UPDATE background_jobs SET
        locked_at=DATE_SUB(CURRENT_TIMESTAMP(3),INTERVAL 120 SECOND),
        heartbeat_at=DATE_SUB(CURRENT_TIMESTAMP(3),INTERVAL 120 SECOND),
        locked_until=DATE_SUB(CURRENT_TIMESTAMP(3),INTERVAL 1 SECOND)
       WHERE id=? AND state='RUNNING'`,
      [jobId],
    );
  }

  it("atomically replaces metadata, preserves provenance and enqueues only the approved next job", async () => {
    const fixture = await createClaimed("success");
    const before = await immutableRows(
      fixture.uploadId,
      fixture.storageObjectId,
    );
    const prepared = await metadata.prepare(fixture.fence);
    expect(prepared).toMatchObject({
      familyId,
      mediaId: fixture.item.id,
      storageObjectId: fixture.storageObjectId,
      generation: 1n,
      keyVersion: 1,
    });
    expect(prepared?.captureUpperBoundUtc).toBe(
      fixture.item.uploadedAt.toISOString(),
    );

    const committed = await metadata.persistResult(
      fixture.fence,
      prepared!,
      imageResult({
        capturedLocalAt: "2025-01-02 03:04:05.123",
        capturedAtUtc: "2025-01-02 00:34:05.123",
        captureOffsetMinutes: 150,
        captureTimezoneKnown: true,
        captureTimeSource: "EXIF_ORIGINAL",
        captureTimeStatus: "OFFSET_KNOWN",
        gpsLatitude: "0.000000",
        gpsLongitude: "180.000000",
        orientation: 6,
        rawWidth: 120,
        rawHeight: 80,
        displayWidth: 80,
        displayHeight: 120,
      }),
    );
    expect(committed).toMatchObject({
      affectedRows: 1,
      mediaState: "PENDING",
      jobState: "SUCCEEDED",
      downstreamJobType: "IMAGE_DERIVATIVES",
    });
    await database.pool.query(
      `UPDATE background_jobs SET state='CANCELLED',finished_at=CURRENT_TIMESTAMP(3)
       WHERE media_id=? AND job_type='IMAGE_DERIVATIVES' AND state='QUEUED'`,
      [fixture.item.id],
    );
    const [rows] = await database.pool.query<RowDataPacket[]>(
      `SELECT CAST(source_upload_id AS CHAR) AS sourceUploadId,
        processing_state AS processingState,CAST(metadata_generation AS CHAR) AS metadataGeneration,
        raw_width AS rawWidth,display_width AS displayWidth,orientation,
        DATE_FORMAT(captured_local_at,'%Y-%m-%d %H:%i:%s.%f') AS capturedLocal,
        DATE_FORMAT(captured_at_utc,'%Y-%m-%d %H:%i:%s.%f') AS capturedUtc,
        captured_offset_minutes AS offsetMinutes,captured_time_status AS timeStatus,
        gps_latitude AS latitude,gps_longitude AS longitude,timeline_basis AS timelineBasis
       FROM media_items WHERE id=?`,
      [fixture.item.id],
    );
    expect(rows[0]).toMatchObject({
      sourceUploadId: fixture.uploadId,
      processingState: "PENDING",
      metadataGeneration: "1",
      rawWidth: 120,
      displayWidth: 80,
      orientation: 6,
      capturedLocal: "2025-01-02 03:04:05.123000",
      capturedUtc: "2025-01-02 00:34:05.123000",
      offsetMinutes: 150,
      timeStatus: "OFFSET_KNOWN",
      latitude: "0.000000",
      longitude: "180.000000",
      timelineBasis: "CAPTURE_LOCAL",
    });
    const [jobRows] = await database.pool.query<RowDataPacket[]>(
      "SELECT job_type AS jobType,state FROM background_jobs WHERE media_id=? ORDER BY id",
      [fixture.item.id],
    );
    expect(jobRows).toEqual([
      expect.objectContaining({ jobType: "MEDIA_PROBE", state: "SUCCEEDED" }),
      expect.objectContaining({
        jobType: "IMAGE_DERIVATIVES",
        state: "CANCELLED",
      }),
    ]);
    expect(
      await metadata.persistResult(
        fixture.fence,
        fixture.preparation,
        imageResult(),
      ),
    ).toEqual({ affectedRows: 0 });
    expect(
      await immutableRows(fixture.uploadId, fixture.storageObjectId),
    ).toEqual(before);
  });

  it("fences a reclaimed worker before either metadata or completion and permits the current epoch", async () => {
    const fixture = await createClaimed("epoch-race");
    expect(await metadata.prepare(fixture.fence)).not.toBeNull();
    await expire(fixture.claimed.id);
    expect(
      await jobs.recoverExpiredLease({
        familyId,
        mediaId: fixture.item.id,
        jobId: fixture.claimed.id,
        generation: 1n,
      }),
    ).toMatchObject({ affectedRows: 1, state: "RETRY_WAIT" });
    await database.pool.query(
      "UPDATE background_jobs SET available_at=DATE_SUB(CURRENT_TIMESTAMP(3),INTERVAL 1 SECOND) WHERE id=?",
      [fixture.claimed.id],
    );
    const current = await reclaimDirect({
      jobId: fixture.claimed.id,
      mediaId: fixture.item.id,
      generation: 1n,
      expectedEpoch: fixture.fence.leaseEpoch,
    });
    expect(current.leaseEpoch).toBe(fixture.fence.leaseEpoch + 1n);
    expect(
      await metadata.persistResult(
        fixture.fence,
        fixture.preparation,
        imageResult({ cameraMake: "stale" }),
      ),
    ).toEqual({ affectedRows: 0 });
    const [unchanged] = await database.pool.query<RowDataPacket[]>(
      "SELECT camera_make AS cameraMake,metadata_generation AS metadataGeneration,state FROM media_items JOIN background_jobs ON background_jobs.id=? WHERE media_items.id=?",
      [fixture.claimed.id, fixture.item.id],
    );
    expect(unchanged[0]).toMatchObject({
      cameraMake: null,
      metadataGeneration: null,
      state: "RUNNING",
    });
    expect(
      await metadata.persistResult(
        current,
        fixture.preparation,
        imageResult({ cameraMake: "current" }),
      ),
    ).toMatchObject({ affectedRows: 1, jobState: "SUCCEEDED" });
    await database.pool.query(
      `UPDATE background_jobs SET state='CANCELLED',finished_at=CURRENT_TIMESTAMP(3)
       WHERE media_id=? AND job_type='IMAGE_DERIVATIVES' AND state='QUEUED'`,
      [fixture.item.id],
    );
  });

  it("rejects generation, storage-state and family races without partial writes", async () => {
    const generation = await createClaimed("generation-race");
    await database.pool.query(
      "UPDATE media_items SET generation=2,processing_state='PENDING' WHERE id=?",
      [generation.item.id],
    );
    expect(
      await metadata.persistResult(
        generation.fence,
        generation.preparation,
        imageResult({ cameraModel: "must-not-write" }),
      ),
    ).toEqual({ affectedRows: 0 });

    const storage = await createClaimed("storage-race");
    await database.pool.query(
      "UPDATE storage_objects SET state='MISSING' WHERE id=?",
      [storage.storageObjectId],
    );
    expect(
      await metadata.persistResult(
        storage.fence,
        storage.preparation,
        imageResult({ cameraModel: "must-not-write" }),
      ),
    ).toEqual({ affectedRows: 0 });
    const [rows] = await database.pool.query<RowDataPacket[]>(
      "SELECT camera_model AS cameraModel,metadata_generation AS metadataGeneration FROM media_items WHERE id IN (?,?) ORDER BY id",
      [generation.item.id, storage.item.id],
    );
    expect(rows.every((row) => row.cameraModel === null)).toBe(true);
    expect(rows.every((row) => row.metadataGeneration === null)).toBe(true);

    const identity = await createClaimed("storage-identity-race");
    await database.pool.query(
      "UPDATE storage_objects SET sha256=? WHERE id=?",
      [randomBytes(32), identity.storageObjectId],
    );
    expect(
      await metadata.persistResult(
        identity.fence,
        identity.preparation,
        imageResult({ cameraModel: "old-identity-must-not-write" }),
      ),
    ).toEqual({ affectedRows: 0 });
    await expect(
      metadata.prepare({ ...storage.fence, familyId: crossFamilyId }),
    ).rejects.toBeInstanceOf(MetadataRepositoryError);
  });

  it("uses snapshot replacement, controlled terminal outcomes and bounded retry", async () => {
    const first = await createClaimed("snapshot-clear");
    await metadata.persistResult(
      first.fence,
      first.preparation,
      imageResult({
        gpsLatitude: "90.000000",
        gpsLongitude: "-180.000000",
        cameraMake: "Synthetic Camera",
        capturedLocalAt: "2025-01-02 03:04:05.000",
        capturedAtUtc: null,
        captureOffsetMinutes: null,
        captureTimezoneKnown: false,
        captureTimeSource: "EXIF_CREATE",
        captureTimeStatus: "OFFSET_UNKNOWN",
      }),
    );
    await database.pool.query(
      `UPDATE background_jobs SET state='CANCELLED',finished_at=CURRENT_TIMESTAMP(3)
       WHERE media_id=? AND job_type='IMAGE_DERIVATIVES' AND state='QUEUED'`,
      [first.item.id],
    );
    await database.pool.query(
      "UPDATE media_items SET generation=2,processing_state='PENDING' WHERE id=?",
      [first.item.id],
    );
    const second = await insertClaimedJob(first.item.id, 2n);
    const secondPreparation = await metadata.prepare(second.fence);
    if (!secondPreparation) throw new Error("expected generation 2 lease");
    await metadata.persistResult(
      second.fence,
      secondPreparation,
      imageResult(),
    );
    await database.pool.query(
      `UPDATE background_jobs SET state='CANCELLED',finished_at=CURRENT_TIMESTAMP(3)
       WHERE media_id=? AND job_type='IMAGE_DERIVATIVES' AND state='QUEUED'`,
      [first.item.id],
    );
    const [cleared] = await database.pool.query<RowDataPacket[]>(
      `SELECT gps_latitude AS latitude,gps_longitude AS longitude,
        camera_make AS cameraMake,captured_local_at AS capturedLocal,
        timeline_basis AS timelineBasis,CAST(metadata_generation AS CHAR) AS metadataGeneration
       FROM media_items WHERE id=?`,
      [first.item.id],
    );
    expect(cleared[0]).toMatchObject({
      latitude: null,
      longitude: null,
      cameraMake: null,
      capturedLocal: null,
      timelineBasis: "UPLOAD_UTC",
      metadataGeneration: "2",
    });

    const unsupported = await createClaimed("unsupported");
    expect(
      await metadata.persistResult(
        unsupported.fence,
        unsupported.preparation,
        imageResult({
          parserStatus: "UNSUPPORTED",
          detectedMediaType: "VIDEO",
          detectedMime: "video/mp4",
          container: "MP4",
          rawWidth: null,
          rawHeight: null,
          displayWidth: null,
          displayHeight: null,
        }),
      ),
    ).toMatchObject({ mediaState: "PARTIAL", jobState: "FAILED" });

    const timeout = await createClaimed("timeout");
    expect(
      await metadata.persistOperationalFailure(
        timeout.fence,
        timeout.preparation,
        "TIMEOUT",
      ),
    ).toMatchObject({ mediaState: "PENDING", jobState: "RETRY_WAIT" });

    const disabled = await createClaimed("capability-disabled");
    expect(
      await metadata.persistOperationalFailure(
        disabled.fence,
        disabled.preparation,
        "CAPABILITY_DISABLED",
      ),
    ).toMatchObject({ mediaState: "FAILED", jobState: "FAILED" });
  });

  it("maps partial, invalid, resource-limit and parser failures to controlled states", async () => {
    const partial = await createClaimed("partial");
    expect(
      await metadata.persistResult(
        partial.fence,
        partial.preparation,
        imageResult({
          parserStatus: "PARTIAL",
          detectedMime: "image/x-adobe-dng",
          container: "DNG_RAW",
          rawWidth: null,
          rawHeight: null,
          displayWidth: null,
          displayHeight: null,
          orientation: 8,
          warnings: ["PARTIAL_METADATA"],
        }),
      ),
    ).toMatchObject({ mediaState: "PARTIAL", jobState: "SUCCEEDED" });

    const invalid = await createClaimed("invalid");
    expect(
      await metadata.persistResult(
        invalid.fence,
        invalid.preparation,
        imageResult({
          parserStatus: "INVALID_MEDIA",
          detectedMediaType: "UNKNOWN",
          detectedMime: "application/octet-stream",
          container: "UNKNOWN",
          rawWidth: null,
          rawHeight: null,
          displayWidth: null,
          displayHeight: null,
          orientation: null,
        }),
      ),
    ).toMatchObject({ mediaState: "FAILED", jobState: "FAILED" });

    const limited = await createClaimed("resource-limit");
    expect(
      await metadata.persistResult(
        limited.fence,
        limited.preparation,
        imageResult({
          parserStatus: "RESOURCE_LIMIT",
          rawWidth: null,
          rawHeight: null,
          displayWidth: null,
          displayHeight: null,
          orientation: null,
        }),
      ),
    ).toMatchObject({ mediaState: "PARTIAL", jobState: "FAILED" });

    const parserFailure = await createClaimed("parser-failure");
    expect(
      await metadata.persistOperationalFailure(
        parserFailure.fence,
        parserFailure.preparation,
        "PARSER_FAILED",
      ),
    ).toMatchObject({ mediaState: "PENDING", jobState: "RETRY_WAIT" });

    const [rows] = await database.pool.query<RowDataPacket[]>(
      `SELECT media_items.processing_state AS mediaState,
        media_items.last_failure_code AS mediaFailure,
        background_jobs.state AS jobState,
        background_jobs.last_failure_code AS jobFailure
       FROM media_items JOIN background_jobs
         ON background_jobs.media_id=media_items.id
        AND background_jobs.job_type='MEDIA_PROBE'
       WHERE media_items.id IN (?,?,?,?) ORDER BY media_items.id`,
      [
        partial.item.id,
        invalid.item.id,
        limited.item.id,
        parserFailure.item.id,
      ],
    );
    expect(rows).toEqual([
      expect.objectContaining({
        mediaState: "PARTIAL",
        mediaFailure: null,
        jobState: "SUCCEEDED",
        jobFailure: null,
      }),
      expect.objectContaining({
        mediaState: "FAILED",
        mediaFailure: "MALFORMED_MEDIA",
        jobState: "FAILED",
        jobFailure: "MALFORMED_MEDIA",
      }),
      expect.objectContaining({
        mediaState: "PARTIAL",
        mediaFailure: "RESOURCE_LIMIT",
        jobState: "FAILED",
        jobFailure: "RESOURCE_LIMIT",
      }),
      expect.objectContaining({
        mediaState: "PENDING",
        mediaFailure: null,
        jobState: "RETRY_WAIT",
        jobFailure: "TEMPORARY_IO",
      }),
    ]);
  });

  async function immutableRows(uploadId: string, storageId: string) {
    const [rows] = await database.pool.query<RowDataPacket[]>(
      `SELECT
        (SELECT state FROM upload_sessions WHERE id=?) AS uploadState,
        (SELECT HEX(computed_sha256) FROM upload_sessions WHERE id=?) AS uploadHash,
        (SELECT state FROM storage_objects WHERE id=?) AS storageState,
        (SELECT HEX(sha256) FROM storage_objects WHERE id=?) AS storageHash,
        (SELECT CAST(byte_size AS CHAR) FROM storage_objects WHERE id=?) AS byteSize`,
      [uploadId, uploadId, storageId, storageId, storageId],
    );
    return rows[0];
  }
});

function imageResult(
  overrides: Partial<NormalizedMetadataResult> = {},
): NormalizedMetadataResult {
  return {
    parserStatus: "SUCCESS",
    detectedMediaType: "IMAGE",
    detectedMime: "image/jpeg",
    container: "JPEG",
    rawWidth: 64,
    rawHeight: 48,
    displayWidth: 64,
    displayHeight: 48,
    orientation: 1,
    isAnimated: false,
    capturedLocalAt: null,
    capturedAtUtc: null,
    captureOffsetMinutes: null,
    captureTimezoneKnown: false,
    captureTimeSource: "NONE",
    captureTimeStatus: "ABSENT",
    gpsLatitude: null,
    gpsLongitude: null,
    cameraMake: null,
    cameraModel: null,
    durationMs: null,
    rotationDegrees: null,
    videoCodec: null,
    warnings: [],
    ...overrides,
  };
}
