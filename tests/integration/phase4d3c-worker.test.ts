import { createHash, randomBytes, randomUUID } from "node:crypto";
import { deflateSync } from "node:zlib";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ResultSetHeader, RowDataPacket } from "mysql2/promise";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { ImageDerivativeProcessor } from "../../apps/worker/src/image-derivative-processor.js";
import { assertMigrationReadiness } from "../../packages/db/src/migration-readiness.js";
import {
  createDatabase,
  MySqlDerivedAdmissionRepository,
  MySqlDerivedAssetFence,
  MySqlJobRepository,
  MySqlMediaRepository,
} from "../../packages/db/src/index.js";
import {
  buildOriginalPath,
  CapacityGate,
  DerivedStore,
  OriginalReader,
  renderUnverifiedCandidate,
  StorageRoot,
  type UnverifiedRenderedCandidate,
} from "../../packages/storage/src/index.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("PHASE4D3C_DEV_DATABASE_URL_REQUIRED");

function syntheticPng(width: number, height: number, seed: number) {
  const crc32 = (bytes: Buffer) => {
    let crc = 0xffffffff;
    for (const byte of bytes) {
      crc ^= byte;
      for (let bit = 0; bit < 8; bit += 1) {
        crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
      }
    }
    return (crc ^ 0xffffffff) >>> 0;
  };
  const chunk = (name: string, contents: Buffer) => {
    const type = Buffer.from(name, "ascii");
    const length = Buffer.alloc(4);
    length.writeUInt32BE(contents.length);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(Buffer.concat([type, contents])));
    return Buffer.concat([length, type, contents, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 6;
  const row = Buffer.alloc(1 + width * 4, seed);
  const raw = Buffer.alloc(row.length * height);
  for (let y = 0; y < height; y += 1) row.copy(raw, y * row.length);
  return Buffer.concat([
    Buffer.from("89504e470d0a1a0a", "hex"),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

function privateDirectory(path: string) {
  mkdirSync(path, { recursive: true });
  const segments = path.split("/");
  const rootIndex = segments.findIndex((segment) =>
    segment.startsWith("ps4d3c-"),
  );
  const start = rootIndex >= 0 ? rootIndex : segments.length - 1;
  for (let index = start; index < segments.length; index += 1) {
    chmodSync(segments.slice(0, index + 1).join("/"), 0o700);
  }
}

describe.sequential("Phase 4D3c worker integration", () => {
  const database = createDatabase(databaseUrl);
  const jobs = new MySqlJobRepository(database.pool);
  const admission = new MySqlDerivedAdmissionRepository(database.pool);
  const assets = new MySqlDerivedAssetFence(database.pool);
  const mediaRepository = new MySqlMediaRepository(database.pool);
  const suffix = randomUUID().replaceAll("-", "");
  const mediaRoot = mkdtempSync(join(realpathSync(tmpdir()), "ps4d3c-"));
  let storageRoot: StorageRoot;
  let gate: CapacityGate;
  let store: DerivedStore;
  let reader: OriginalReader;
  let familyId = "";
  let memberId = "";
  const workerA = MySqlJobRepository.createWorkerIdentity();
  const workerB = MySqlJobRepository.createWorkerIdentity();

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
        throw new Error("PHASE4D3C_DEV_PREFLIGHT_FAILED");
      }
      await assertMigrationReadiness(connection);
      const [family] = await connection.query<ResultSetHeader>(
        "INSERT INTO families (name) VALUES (?)",
        [`D3c synthetic ${suffix}`],
      );
      familyId = String(family.insertId);
      const username = `d3c_${suffix}`;
      const [user] = await connection.query<ResultSetHeader>(
        `INSERT INTO users
          (username,username_normalized,password_hash,display_name,password_changed_at)
         VALUES (?,?,?,?,CURRENT_TIMESTAMP(3))`,
        [username, Buffer.from(username), "synthetic-not-used", "D3c"],
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
    reader = OriginalReader.open({
      mediaRoot,
      expectedMarkerId: storageRoot.markerId,
    });
  });

  afterAll(async () => {
    reader.close();
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
        `d3c_${suffix}`,
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

  function publishImage(bytes: Buffer) {
    const digest = createHash("sha256").update(bytes).digest("hex");
    const relative = buildOriginalPath(familyId, digest, String(bytes.length));
    if (!existsSync(join(mediaRoot, relative))) {
      const uploadId = randomBytes(16).toString("hex");
      storageRoot.createUploadPayload(familyId, uploadId, bytes);
      storageRoot.publishOriginal({
        familyId,
        uploadId,
        sha256Hex: digest,
        byteSize: String(bytes.length),
      });
    }
    return { digest, bytes };
  }

  let imageSeed = 50;

  async function mediaFixture(image?: Buffer) {
    const bytes = image ?? syntheticPng(8, 4, imageSeed++);
    const published = publishImage(bytes);
    const sha = Buffer.from(published.digest, "hex");
    const [object] = await database.pool.query<ResultSetHeader>(
      `INSERT INTO storage_objects
        (family_id,sha256,byte_size,key_version,state,durable_at,verified_at)
       VALUES (?,?,?,1,'AVAILABLE',CURRENT_TIMESTAMP(3),CURRENT_TIMESTAMP(3))`,
      [familyId, sha, bytes.length],
    );
    const [upload] = await database.pool.query<ResultSetHeader>(
      `INSERT INTO upload_sessions
        (public_id,family_id,created_by_member_id,original_filename,
         declared_size,committed_offset,state,computed_sha256,
         finalize_started_at,storage_object_id,completed_at,expires_at)
       VALUES (?,?,?,'synthetic.png',?,?, 'COMPLETE',?,
         CURRENT_TIMESTAMP(3),?,CURRENT_TIMESTAMP(3),
         DATE_ADD(CURRENT_TIMESTAMP(3),INTERVAL 1 DAY))`,
      [
        randomBytes(16),
        familyId,
        memberId,
        bytes.length,
        bytes.length,
        sha,
        String(object.insertId),
      ],
    );
    const created = await mediaRepository.createOrGetCanonicalMedia({
      familyId,
      uploadId: String(upload.insertId),
    });
    await database.pool.query(
      `UPDATE media_items
       SET metadata_generation=generation, media_type='IMAGE', detected_mime='image/png'
       WHERE id=? AND family_id=?`,
      [created.media.id, familyId],
    );
    const enqueued = await jobs.enqueue({
      familyId,
      mediaId: created.media.id,
      generation: 1n,
      recipeId: 1,
      jobType: "IMAGE_DERIVATIVES",
    });
    return { mediaId: created.media.id, jobId: enqueued.job.id, sha };
  }

  async function expireLease(jobId: string) {
    await database.pool.query(
      `UPDATE background_jobs
       SET locked_at=DATE_SUB(UTC_TIMESTAMP(3), INTERVAL 10 SECOND),
           heartbeat_at=DATE_SUB(UTC_TIMESTAMP(3), INTERVAL 9 SECOND),
           locked_until=DATE_SUB(UTC_TIMESTAMP(3), INTERVAL 1 SECOND)
       WHERE id=?`,
      [jobId],
    );
  }

  async function makeRecoveredClaimable(jobId: string) {
    await database.pool.query(
      "UPDATE background_jobs SET available_at=UTC_TIMESTAMP(3) WHERE id=? AND state='RETRY_WAIT'",
      [jobId],
    );
  }

  function processor(
    render: (input: {
      familyId: string;
      sha256Hex: string;
      byteSize: string;
      kind: "THUMBNAIL" | "PREVIEW";
    }) => Promise<UnverifiedRenderedCandidate>,
    fence: MySqlDerivedAssetFence = assets,
  ) {
    return new ImageDerivativeProcessor(
      jobs,
      admission,
      fence,
      { capability: { state: "READ_WRITE", root: storageRoot }, gate, store },
      render,
    );
  }

  async function realRender(input: {
    familyId: string;
    sha256Hex: string;
    byteSize: string;
    kind: "THUMBNAIL" | "PREVIEW";
  }) {
    return reader.withVerifiedOriginal(input, (handle) =>
      renderUnverifiedCandidate(handle, input.kind),
    );
  }

  it("claims only image jobs, heartbeats, and completes both kinds", async () => {
    const probeMedia = await mediaFixture(syntheticPng(8, 4, 41));
    await database.pool.query("DELETE FROM background_jobs WHERE id=?", [
      probeMedia.jobId,
    ]);
    await jobs.enqueue({
      familyId,
      mediaId: probeMedia.mediaId,
      generation: 1n,
      recipeId: 1,
      jobType: "MEDIA_PROBE",
    });
    const { jobId, mediaId } = await mediaFixture(syntheticPng(8, 4, 42));
    const claimed = await jobs.claimNext(workerA, {
      jobType: "IMAGE_DERIVATIVES",
    });
    expect(claimed?.id).toBe(jobId);
    expect(claimed?.jobType).toBe("IMAGE_DERIVATIVES");
    const [before] = await database.pool.query<RowDataPacket[]>(
      "SELECT locked_until AS lockedUntil FROM background_jobs WHERE id=?",
      [jobId],
    );
    const result = await processor(realRender).runClaimed(claimed!, workerA);
    expect(result.outcome).toBe("READY");
    const [rows] = await database.pool.query<RowDataPacket[]>(
      `SELECT background_jobs.state AS jobState,
         background_jobs.lease_epoch AS epoch,
         background_jobs.locked_until AS lockedUntil,
         derived_assets.kind AS kind, derived_assets.state AS assetState,
         derived_assets.published_at AS publishedAt,
         media_items.processing_state AS mediaState
       FROM background_jobs
       JOIN derived_assets ON derived_assets.producer_job_id = background_jobs.id
       JOIN media_items ON media_items.id = background_jobs.media_id
       WHERE background_jobs.id=?
       ORDER BY derived_assets.kind`,
      [jobId],
    );
    expect(rows.map((row) => row.assetState)).toEqual(["READY", "READY"]);
    expect(rows.every((row) => row.publishedAt instanceof Date)).toBe(true);
    expect(rows[0]).toMatchObject({
      jobState: "SUCCEEDED",
      mediaState: "READY",
    });
    expect(BigInt(String(rows[0]?.epoch))).toBeGreaterThan(0n);
    expect(rows[0]?.lockedUntil).not.toEqual(before[0]?.lockedUntil);
    expect(
      existsSync(
        join(
          mediaRoot,
          "derived",
          familyId,
          mediaId,
          "r1",
          "g1",
          "thumbnail.webp",
        ),
      ),
    ).toBe(true);
    expect(
      existsSync(
        join(
          mediaRoot,
          "derived",
          familyId,
          mediaId,
          "r1",
          "g1",
          "preview.webp",
        ),
      ),
    ).toBe(true);
  }, 60_000);

  it("gives a stale worker zero effects and lets the next lease continue", async () => {
    const { jobId, mediaId } = await mediaFixture();
    const claimed = await jobs.claimNext(workerA, {
      jobType: "IMAGE_DERIVATIVES",
    });
    expect(claimed?.id).toBe(jobId);
    let firstRendered = 0;
    const stale = await processor(async (input) => {
      firstRendered += 1;
      await expireLease(jobId);
      return realRender(input);
    }).runClaimed(claimed!, workerA);
    expect(stale.outcome).toBe("STALE");
    expect(firstRendered).toBe(1);
    expect(
      existsSync(
        join(
          mediaRoot,
          "derived",
          familyId,
          mediaId,
          "r1",
          "g1",
          "thumbnail.webp",
        ),
      ),
    ).toBe(false);
    const recovered = await jobs.recoverExpiredLease({
      familyId,
      mediaId,
      jobId,
      generation: 1n,
    });
    expect(recovered.affectedRows).toBe(1);
    await makeRecoveredClaimable(jobId);
    let continuedRendered = 0;
    const continued = await processor(async () => {
      continuedRendered += 1;
      throw new Error("RENDERER_RIFF_INVALID");
    }).run(workerB);
    expect(continuedRendered).toBe(1);
    expect(continued.outcome).toBe("FAILED");
    expect(continued.failureCode).toBe("MALFORMED_MEDIA");
  }, 60_000);

  it("has zero effects when the media generation changes", async () => {
    const { jobId, mediaId } = await mediaFixture();
    const claimed = await jobs.claimNext(workerA, {
      jobType: "IMAGE_DERIVATIVES",
    });
    expect(claimed?.id).toBe(jobId);
    await database.pool.query(
      "UPDATE media_items SET generation=2 WHERE id=? AND family_id=?",
      [mediaId, familyId],
    );
    let rendered = 0;
    const result = await processor(async () => {
      rendered += 1;
      throw new Error("should not render");
    }).runClaimed(claimed!, workerA);
    expect(result.outcome).toBe("STALE");
    expect(rendered).toBe(0);
    const [rows] = await database.pool.query<RowDataPacket[]>(
      `SELECT state, (SELECT COUNT(*) FROM derived_assets WHERE producer_job_id=?) AS assets
       FROM background_jobs WHERE id=?`,
      [jobId, jobId],
    );
    expect(rows[0]?.state).toBe("RUNNING");
    expect(Number(rows[0]?.assets)).toBe(0);
  });

  it("does not mark the job succeeded when preview fails", async () => {
    const { jobId } = await mediaFixture();
    const kinds: string[] = [];
    const result = await processor(async (input) => {
      kinds.push(input.kind);
      if (input.kind === "PREVIEW") throw new Error("TEMPORARY_IO");
      return realRender(input);
    }).run(workerA);
    expect(kinds).toEqual(["THUMBNAIL", "PREVIEW"]);
    expect(result.outcome).toBe("RETRY_WAIT");
    const [rows] = await database.pool.query<RowDataPacket[]>(
      `SELECT background_jobs.state AS jobState, derived_assets.kind AS kind,
         derived_assets.state AS assetState
       FROM background_jobs
       LEFT JOIN derived_assets ON derived_assets.producer_job_id=background_jobs.id
       WHERE background_jobs.id=?`,
      [jobId],
    );
    expect(rows.some((row) => row.jobState === "SUCCEEDED")).toBe(false);
    expect(rows.find((row) => row.kind === "THUMBNAIL")?.assetState).toBe(
      "READY",
    );
    const [media] = await database.pool.query<RowDataPacket[]>(
      "SELECT processing_state AS processingState FROM media_items WHERE id=(SELECT media_id FROM background_jobs WHERE id=?)",
      [jobId],
    );
    expect(media[0]?.processingState).toBe("PENDING");
    expect(
      rows.some((row) => row.kind === "PREVIEW" && row.assetState === "READY"),
    ).toBe(false);
  }, 60_000);

  it("does not publish again after an unknown publishing commit", async () => {
    const { jobId, mediaId } = await mediaFixture(syntheticPng(8, 4, 43));
    const losing = new MySqlDerivedAssetFence(database.pool);
    const original = losing.markPublishing.bind(losing);
    losing.markPublishing = (fence, payload) =>
      original(fence, payload, {
        commit: async (connection) => {
          connection.destroy();
          throw new Error("commit lost");
        },
      });
    const result = await processor(realRender, losing).run(workerA);
    expect(result.outcome).toBe("COMMIT_UNKNOWN");
    expect(
      existsSync(
        join(
          mediaRoot,
          "derived",
          familyId,
          mediaId,
          "r1",
          "g1",
          "thumbnail.webp",
        ),
      ),
    ).toBe(false);
    const [job] = await database.pool.query<RowDataPacket[]>(
      "SELECT state FROM background_jobs WHERE id=?",
      [jobId],
    );
    expect(job[0]?.state).not.toBe("SUCCEEDED");
  }, 60_000);

  it("fails the thumbnail without publishing preview or succeeding the job", async () => {
    const { jobId } = await mediaFixture();
    const kinds: string[] = [];
    const result = await processor(async (input) => {
      kinds.push(input.kind);
      throw new Error("RENDERER_LAUNCH_FAILED");
    }).run(workerA);
    expect(kinds).toEqual(["THUMBNAIL"]);
    expect(result.outcome).toBe("FAILED");
    expect(result.failureCode).toBe("CAPABILITY_UNAVAILABLE");
    const [rows] = await database.pool.query<RowDataPacket[]>(
      `SELECT background_jobs.state AS jobState, derived_assets.kind AS kind,
         derived_assets.state AS assetState
       FROM background_jobs
       LEFT JOIN derived_assets ON derived_assets.producer_job_id=background_jobs.id
       WHERE background_jobs.id=?`,
      [jobId],
    );
    expect(rows.every((row) => row.jobState === "FAILED")).toBe(true);
    const [media] = await database.pool.query<RowDataPacket[]>(
      `SELECT processing_state AS processingState, last_failure_code AS failureCode
       FROM media_items WHERE id=(SELECT media_id FROM background_jobs WHERE id=?)`,
      [jobId],
    );
    expect(media[0]).toMatchObject({
      processingState: "PARTIAL",
      failureCode: "CAPABILITY_UNAVAILABLE",
    });
    expect(rows.some((row) => row.kind === "PREVIEW")).toBe(false);
    expect(rows.some((row) => row.assetState === "READY")).toBe(false);
  });

  it("keeps the published file when the post-publish fence is lost", async () => {
    const { jobId, mediaId } = await mediaFixture();
    const fenced = new MySqlDerivedAssetFence(database.pool);
    const original = fenced.confirmPublishing.bind(fenced);
    fenced.confirmPublishing = async (fence, payload) => {
      const confirmed = await original(fence, payload);
      return confirmed === "COMMITTED" ? "STALE" : confirmed;
    };
    const result = await processor(realRender, fenced).run(workerA);
    expect(result.outcome).toBe("STALE");
    expect(
      existsSync(
        join(
          mediaRoot,
          "derived",
          familyId,
          mediaId,
          "r1",
          "g1",
          "thumbnail.webp",
        ),
      ),
    ).toBe(true);
    const [rows] = await database.pool.query<RowDataPacket[]>(
      `SELECT background_jobs.state AS jobState, derived_assets.state AS assetState
       FROM background_jobs
       JOIN derived_assets ON derived_assets.producer_job_id=background_jobs.id
       WHERE background_jobs.id=? AND derived_assets.kind='THUMBNAIL'`,
      [jobId],
    );
    expect(rows[0]).toMatchObject({
      jobState: "RUNNING",
      assetState: "PUBLISHING",
    });
  }, 60_000);

  it("does not let a stale worker mark READY after publish", async () => {
    const { jobId, mediaId } = await mediaFixture();
    const fenced = new MySqlDerivedAssetFence(database.pool);
    const original = fenced.commitSucceeded.bind(fenced);
    fenced.commitSucceeded = async (fence, evidence, options) => {
      await expireLease(jobId);
      return original(fence, evidence, options);
    };
    const stale = await processor(realRender, fenced).run(workerA);
    expect(stale.outcome).toBe("STALE");
    const [before] = await database.pool.query<RowDataPacket[]>(
      `SELECT background_jobs.state AS jobState, derived_assets.state AS assetState
       FROM background_jobs
       JOIN derived_assets ON derived_assets.producer_job_id=background_jobs.id
       WHERE background_jobs.id=?`,
      [jobId],
    );
    expect(before.every((row) => row.jobState === "RUNNING")).toBe(true);
    expect(before.map((row) => row.assetState).sort()).toEqual([
      "PUBLISHING",
      "PUBLISHING",
    ]);
    await jobs.recoverExpiredLease({
      familyId,
      mediaId,
      jobId,
      generation: 1n,
    });
    await makeRecoveredClaimable(jobId);
    let rendered = 0;
    const continued = await processor(async () => {
      rendered += 1;
      throw new Error("should not render");
    }).run(workerB);
    expect(rendered).toBe(0);
    expect(continued.outcome).toBe("READY");
    const [after] = await database.pool.query<RowDataPacket[]>(
      `SELECT background_jobs.state AS jobState,
         derived_assets.state AS assetState,
         media_items.processing_state AS mediaState
       FROM background_jobs
       JOIN derived_assets ON derived_assets.producer_job_id=background_jobs.id
       JOIN media_items ON media_items.id=background_jobs.media_id
       WHERE background_jobs.id=?`,
      [jobId],
    );
    expect(after.map((row) => row.assetState)).toEqual(["READY", "READY"]);
    expect(after[0]).toMatchObject({
      jobState: "SUCCEEDED",
      mediaState: "READY",
    });
  }, 60_000);

  it("does not mark READY when the final file or its SHA does not match", async () => {
    const missing = await mediaFixture();
    const missingGate = gate.inspectDerivedFinal.bind(gate);
    gate.inspectDerivedFinal = async (input) => {
      if (input.kind === "THUMBNAIL") {
        const path = join(
          mediaRoot,
          "derived",
          familyId,
          missing.mediaId,
          "r1",
          "g1",
          "thumbnail.webp",
        );
        if (existsSync(path)) rmSync(path);
      }
      return missingGate(input);
    };
    const missingResult = await processor(realRender).run(workerA);
    gate.inspectDerivedFinal = missingGate;
    expect(missingResult.outcome).toBe("PUBLISHING");
    const [missingJob] = await database.pool.query<RowDataPacket[]>(
      "SELECT state FROM background_jobs WHERE id=?",
      [missing.jobId],
    );
    expect(missingJob[0]?.state).toBe("RUNNING");

    const mismatched = await mediaFixture();
    const mismatchGate = gate.inspectDerivedFinal.bind(gate);
    gate.inspectDerivedFinal = async (input) => {
      const fact = await mismatchGate(input);
      return { ...fact, sha256Hex: "ab".repeat(32) };
    };
    const mismatchResult = await processor(realRender).run(workerB);
    gate.inspectDerivedFinal = mismatchGate;
    expect(mismatchResult.outcome).toBe("PUBLISHING");
    const [mismatchRows] = await database.pool.query<RowDataPacket[]>(
      `SELECT background_jobs.state AS jobState, derived_assets.state AS assetState
       FROM background_jobs
       JOIN derived_assets ON derived_assets.producer_job_id=background_jobs.id
       WHERE background_jobs.id=?`,
      [mismatched.jobId],
    );
    expect(mismatchRows.every((row) => row.jobState === "RUNNING")).toBe(true);
    expect(mismatchRows.every((row) => row.assetState === "PUBLISHING")).toBe(
      true,
    );
  }, 60_000);

  it("does not repeat READY after an unknown commit", async () => {
    const { jobId } = await mediaFixture();
    const losing = new MySqlDerivedAssetFence(database.pool);
    let attempts = 0;
    const original = losing.commitSucceeded.bind(losing);
    losing.commitSucceeded = (fence, evidence, options) => {
      attempts += 1;
      return original(fence, evidence, {
        ...options,
        commit: async (connection) => {
          connection.destroy();
          throw new Error("commit lost");
        },
      });
    };
    const result = await processor(realRender, losing).run(workerA);
    expect(result.outcome).toBe("COMMIT_UNKNOWN");
    expect(attempts).toBe(1);
    const [rows] = await database.pool.query<RowDataPacket[]>(
      `SELECT background_jobs.state AS jobState, derived_assets.state AS assetState
       FROM background_jobs
       JOIN derived_assets ON derived_assets.producer_job_id=background_jobs.id
       WHERE background_jobs.id=?`,
      [jobId],
    );
    expect(rows.every((row) => row.jobState === "RUNNING")).toBe(true);
    expect(rows.every((row) => row.assetState === "PUBLISHING")).toBe(true);
  }, 60_000);

  it("has zero READY effects when the generation changes before commit", async () => {
    const { jobId, mediaId } = await mediaFixture();
    const fenced = new MySqlDerivedAssetFence(database.pool);
    const original = fenced.commitSucceeded.bind(fenced);
    fenced.commitSucceeded = async (fence, evidence, options) => {
      await database.pool.query(
        "UPDATE media_items SET generation=2 WHERE id=? AND family_id=?",
        [mediaId, familyId],
      );
      return original(fence, evidence, options);
    };
    const result = await processor(realRender, fenced).run(workerA);
    expect(result.outcome).toBe("STALE");
    const [rows] = await database.pool.query<RowDataPacket[]>(
      `SELECT background_jobs.state AS jobState, derived_assets.state AS assetState
       FROM background_jobs
       JOIN derived_assets ON derived_assets.producer_job_id=background_jobs.id
       WHERE background_jobs.id=?`,
      [jobId],
    );
    expect(rows.every((row) => row.jobState === "RUNNING")).toBe(true);
    expect(rows.every((row) => row.assetState === "PUBLISHING")).toBe(true);
  }, 60_000);
});
