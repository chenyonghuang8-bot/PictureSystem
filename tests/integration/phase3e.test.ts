import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { Readable } from "node:stream";

import type { ResultSetHeader, RowDataPacket } from "mysql2/promise";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  createSessionToken,
  hashPassword,
  hashSessionToken,
  normalizeUsername,
} from "../../packages/auth/src/index.js";
import {
  CommitOutcomeUnknownError,
  createDatabase,
  MySqlUploadRepository,
  type Phase1CActor,
} from "../../packages/db/dist/index.js";
import {
  buildOriginalPath,
  buildUploadPayloadPath,
  StorageRoot,
  StorageSafetyError,
} from "../../packages/storage/src/index.js";
import type { AuthContext } from "../../apps/api/src/auth/service.js";
import { UploadMutex } from "../../apps/api/src/uploads/mutex.js";
import { StorageReconciler } from "../../apps/api/src/uploads/recovery.js";
import { UploadService } from "../../apps/api/src/uploads/service.js";

if (!process.env.DATABASE_URL)
  throw new Error("PHASE3E_DEV_DATABASE_URL_REQUIRED");

describe("Phase 3E synthetic MySQL/filesystem recovery and races", () => {
  const database = createDatabase(process.env.DATABASE_URL!);
  const repository = new MySqlUploadRepository(database.pool);
  const fixture = mkdtempSync(join(realpathSync(tmpdir()), "phase3e-mysql-"));
  const root = StorageRoot.open(join(fixture, "media"), { initialize: true });
  const service = new UploadService(repository, { state: "READ_WRITE", root });
  const mutex = new UploadMutex();
  const suffix = randomUUID().replaceAll("-", "");
  const username = `phase3e_${suffix}`;
  let familyId = "";
  let userId = "";
  let actor: Phase1CActor;
  let context: AuthContext;

  beforeAll(async () => {
    await repository.assertRecoveryReadiness();
    const syntheticHash = await hashPassword("phase3e-synthetic-only-password");
    const connection = await database.pool.getConnection();
    try {
      await connection.query("SET SESSION time_zone = '+00:00'");
      await connection.beginTransaction();
      const [family] = await connection.query<ResultSetHeader>(
        "INSERT INTO families (name) VALUES (?)",
        [`Phase 3E synthetic ${suffix}`],
      );
      familyId = String(family.insertId);
      const [user] = await connection.query<ResultSetHeader>(
        `INSERT INTO users (username,username_normalized,password_hash,
          display_name,password_changed_at) VALUES (?,?,?,?,CURRENT_TIMESTAMP(3))`,
        [
          username,
          normalizeUsername(username).normalizedBytes,
          syntheticHash,
          "Phase3E synthetic",
        ],
      );
      userId = String(user.insertId);
      const [member] = await connection.query<ResultSetHeader>(
        "INSERT INTO family_members (family_id,user_id,role) VALUES (?,?,'MEMBER')",
        [familyId, userId],
      );
      if (!member.insertId)
        throw new Error("PHASE3E_SYNTHETIC_MEMBER_REQUIRED");
      const tokenHash = hashSessionToken(createSessionToken());
      const [session] = await connection.query<ResultSetHeader>(
        `INSERT INTO sessions (user_id,token_hash,client_type,
           authenticated_at,last_seen_at,expires_at)
         VALUES (?,?,'WEB',CURRENT_TIMESTAMP(3),CURRENT_TIMESTAMP(3),
           DATE_ADD(CURRENT_TIMESTAMP(3),INTERVAL 30 DAY))`,
        [userId, tokenHash],
      );
      actor = { userId, sessionId: String(session.insertId), tokenHash };
      context = {
        identity: {
          userId,
          sessionId: actor.sessionId,
          username,
          displayName: "Phase3E synthetic",
        },
        rawToken: "synthetic-test-only",
        tokenHash,
      } as AuthContext;
      await connection.commit();
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
  }, 20_000);

  afterAll(async () => {
    try {
      if (familyId) {
        const connection = await database.pool.getConnection();
        try {
          await connection.beginTransaction();
          await connection.query(
            "DELETE FROM upload_sessions WHERE family_id=?",
            [familyId],
          );
          await connection.query(
            "DELETE FROM storage_objects WHERE family_id=?",
            [familyId],
          );
          await connection.query("DELETE FROM sessions WHERE user_id=?", [
            userId,
          ]);
          await connection.query(
            "DELETE FROM family_members WHERE family_id=?",
            [familyId],
          );
          await connection.query("DELETE FROM users WHERE id=?", [userId]);
          await connection.query("DELETE FROM families WHERE id=?", [familyId]);
          await connection.commit();
          const [remaining] = await connection.query<RowDataPacket[]>(
            "SELECT COUNT(*) AS count FROM upload_sessions WHERE family_id=?",
            [familyId],
          );
          expect(Number(remaining[0]?.count)).toBe(0);
        } catch (error) {
          await connection.rollback();
          throw error;
        } finally {
          connection.release();
        }
      }
    } finally {
      await database.pool.end();
      root.close();
      expect(relative(realpathSync(tmpdir()), fixture)).toMatch(
        /^phase3e-mysql-[^/]+$/u,
      );
      rmSync(fixture, { recursive: true, force: true });
      expect(existsSync(fixture)).toBe(false);
    }
  }, 30_000);

  function scanner(repo = repository) {
    return new StorageReconciler(repo, { state: "READ_WRITE", root }, mutex);
  }

  function plan(mode: "dry-run" | "recover" | "cleanup-staging" = "dry-run") {
    return { mode, familyScope: familyId, maxCandidates: 512 } as const;
  }

  async function create(size = 8n) {
    return service.create(context, {
      familyId,
      publicId: randomBytes(16),
      declaredSize: size,
      filename: "phase3e-synthetic.bin",
      reportedMime: null,
    });
  }

  async function filled(bytes: Buffer) {
    const upload = await create(BigInt(bytes.length));
    await service.patch(
      context,
      Buffer.from(upload.publicId, "hex"),
      0n,
      Readable.from([bytes]),
    );
    return upload;
  }

  it("expires an old CREATED receipt only after a locked server-time check and cleans exact staging", async () => {
    const upload = await create();
    const path = join(
      root.canonicalPath,
      buildUploadPayloadPath(familyId, upload.publicId),
    );
    await database.pool.query(
      `UPDATE upload_sessions SET created_at=DATE_SUB(CURRENT_TIMESTAMP(3),INTERVAL 9 DAY),
        updated_at=DATE_SUB(CURRENT_TIMESTAMP(3),INTERVAL 8 DAY),
        expires_at=DATE_SUB(CURRENT_TIMESTAMP(3),INTERVAL 1 DAY)
       WHERE public_id=?`,
      [Buffer.from(upload.publicId, "hex")],
    );
    const dry = await scanner().run(plan());
    expect(dry.expiredTransitioned).toBe(0);
    expect(existsSync(path)).toBe(true);
    const recovered = await scanner().run(plan("recover"));
    expect(recovered.expiredTransitioned).toBeGreaterThanOrEqual(1);
    expect(existsSync(path)).toBe(false);
    const terminal = await repository.trustedState(
      Buffer.from(upload.publicId, "hex"),
    );
    expect(terminal.state).toBe("EXPIRED");
    expect(terminal.stagingCleanedAt).not.toBeNull();
  });

  it("keeps an active upload and restores only DB-authoritative staging prefix", async () => {
    const upload = await create(8n);
    const publicId = Buffer.from(upload.publicId, "hex");
    const scratch = randomBytes(16).toString("hex");
    root.createChunkScratch(upload.publicId, scratch, Buffer.from("extra"));
    root.commitChunk({
      familyId,
      uploadId: upload.publicId,
      requestId: scratch,
      expectedOffset: 0n,
      declaredSize: 8n,
    });
    root.removeChunkScratch(upload.publicId, scratch);
    expect(root.inspectUploadPayload(familyId, upload.publicId)).toBe(5n);
    await scanner().run(plan("recover"));
    expect(root.inspectUploadPayload(familyId, upload.publicId)).toBe(0n);
    expect((await repository.trustedState(publicId)).state).toBe("CREATED");
    const committed = await service.patch(
      context,
      publicId,
      0n,
      Readable.from(["good"]),
    );
    root.truncateUploadPayload(familyId, upload.publicId, 0n);
    const broken = await scanner().run(plan("recover"));
    expect(broken.integrityMismatches).toBeGreaterThan(0);
    expect((await repository.trustedState(publicId)).state).toBe("FAILED");
    expect(committed.committedOffset).toBe(4n);
    await scanner().run(plan("recover"));
    const failed = await repository.trustedState(publicId);
    expect(failed.state).toBe("FAILED");
    expect(failed.stagingCleanedAt).not.toBeNull();
  });

  it("rechecks upload expiry after waiting on a real family row lock", async () => {
    const upload = await create();
    const publicId = Buffer.from(upload.publicId, "hex");
    const blocker = await database.pool.getConnection();
    try {
      await blocker.beginTransaction();
      await blocker.query("SELECT id FROM families WHERE id=? FOR UPDATE", [
        familyId,
      ]);
      let arrived!: () => void;
      const arrival = new Promise<void>((resolve) => {
        arrived = resolve;
      });
      const waiting = Object.create(repository) as MySqlUploadRepository;
      waiting.systemRevalidate = async (id, expire) => {
        if (id.equals(publicId)) arrived();
        return repository.systemRevalidate(id, expire);
      };
      const scan = scanner(waiting).run({
        ...plan("recover"),
        afterUploadId: (BigInt(upload.id) - 1n).toString(),
      });
      await arrival;
      // The family lock is held by another real connection. The scanner's
      // fresh locking read must see this changed expiry, not its early scan.
      await blocker.query(
        `UPDATE upload_sessions SET
          created_at=DATE_SUB(CURRENT_TIMESTAMP(3),INTERVAL 9 DAY),
          expires_at=DATE_SUB(CURRENT_TIMESTAMP(3),INTERVAL 1 DAY),
          updated_at=DATE_SUB(CURRENT_TIMESTAMP(3),INTERVAL 8 DAY)
         WHERE public_id=?`,
        [publicId],
      );
      await blocker.commit();
      const result = await scan;
      expect(result.expiredTransitioned).toBeGreaterThanOrEqual(1);
      expect((await repository.trustedState(publicId)).state).toBe("EXPIRED");
      expect(
        existsSync(
          join(
            root.canonicalPath,
            buildUploadPayloadPath(familyId, upload.publicId),
          ),
        ),
      ).toBe(false);
    } finally {
      await blocker.rollback().catch(() => undefined);
      blocker.release();
    }
  }, 20_000);

  it("verifies frozen FINALIZING staging and final candidates without system-auth completion", async () => {
    const bytes = Buffer.from("known-intent-original");
    const sha = createHash("sha256").update(bytes).digest();
    const first = await filled(bytes);
    const firstId = Buffer.from(first.publicId, "hex");
    await repository.beginFinalize({ actor, publicId: firstId, sha256: sha });
    chmodSync(
      join(
        root.canonicalPath,
        buildUploadPayloadPath(familyId, first.publicId),
      ),
      0o400,
    ); // synthetic post-prepare crash window
    const stage = await scanner().run(plan("recover"));
    expect(stage.finalizingCandidatesVerified).toBeGreaterThan(0);
    expect(stage.skippedUnsafeEntries).toBe(0);
    expect(stage.finalizingAutoCompleted).toBe(0);
    expect((await repository.trustedState(firstId)).state).toBe("FINALIZING");
    root.publishOriginal({
      familyId,
      uploadId: first.publicId,
      sha256Hex: sha.toString("hex"),
      byteSize: String(bytes.length),
    });
    const final = await scanner().run(plan());
    expect(final.knownRecoverableFinalizingCandidates).toBeGreaterThan(0);
    expect(final.orphanFinalCandidates).toBe(0);
    expect((await repository.trustedState(firstId)).state).toBe("FINALIZING");
    const completed = await mutex.runExclusive(first.publicId, () =>
      service.finalize(context, firstId),
    );
    expect(completed.state).toBe("COMPLETE");
    const preparedResidue = join(
      root.canonicalPath,
      root.createUploadPayload(familyId, first.publicId, bytes),
    );
    chmodSync(preparedResidue, 0o400);
    const residueReport = await scanner().run(plan("recover"));
    expect(residueReport.terminalStagingResidue).toBeGreaterThan(0);
    expect(existsSync(preparedResidue)).toBe(false);
    const second = await filled(bytes);
    const secondId = Buffer.from(second.publicId, "hex");
    await repository.beginFinalize({ actor, publicId: secondId, sha256: sha });
    expect(
      (await scanner().run(plan())).finalizingCandidatesVerified,
    ).toBeGreaterThan(0);
    expect((await repository.trustedState(secondId)).state).toBe("FINALIZING");
    expect(
      (
        await mutex.runExclusive(second.publicId, () =>
          service.finalize(context, secondId),
        )
      ).state,
    ).toBe("COMPLETE");
  });

  it("retains FINALIZING on missing or mismatched candidates for authenticated retry/review", async () => {
    const missingBytes = Buffer.from("missing-finalizing-synthetic");
    const missing = await filled(missingBytes);
    const missingId = Buffer.from(missing.publicId, "hex");
    await repository.beginFinalize({
      actor,
      publicId: missingId,
      sha256: createHash("sha256").update(missingBytes).digest(),
    });
    root.removeUploadPayload(familyId, missing.publicId);
    const absent = await scanner().run(plan("recover"));
    expect(absent.integrityMismatches).toBeGreaterThan(0);
    expect((await repository.trustedState(missingId)).state).toBe("FINALIZING");

    const mismatchBytes = Buffer.from("mismatched-finalizing-synthetic");
    const mismatch = await filled(mismatchBytes);
    const mismatchId = Buffer.from(mismatch.publicId, "hex");
    await repository.beginFinalize({
      actor,
      publicId: mismatchId,
      sha256: createHash("sha256").update(mismatchBytes).digest(),
    });
    root.truncateUploadPayload(familyId, mismatch.publicId, 1n);
    const mismatched = await scanner().run(plan("recover"));
    expect(mismatched.integrityMismatches).toBeGreaterThan(0);
    expect((await repository.trustedState(mismatchId)).state).toBe(
      "FINALIZING",
    );
  });

  it("makes terminal cleanup idempotent and refuses a symlink-swapped staging payload", async () => {
    const missing = await create();
    const missingId = Buffer.from(missing.publicId, "hex");
    await service.abort(context, missingId);
    await database.pool.query(
      "UPDATE upload_sessions SET staging_cleaned_at=NULL WHERE public_id=?",
      [missingId],
    );
    const repaired = await scanner().run(plan("cleanup-staging"));
    expect(repaired.errors).toBe(0);
    expect(
      (await repository.trustedState(missingId)).stagingCleanedAt,
    ).not.toBeNull();

    const swapped = await create();
    const swappedId = Buffer.from(swapped.publicId, "hex");
    await database.pool.query(
      `UPDATE upload_sessions SET state='ABORTED', terminal_at=CURRENT_TIMESTAMP(3)
       WHERE public_id=? AND state='CREATED'`,
      [swappedId],
    );
    const payload = join(
      root.canonicalPath,
      buildUploadPayloadPath(familyId, swapped.publicId),
    );
    rmSync(payload); // synthetic fault injection only
    const external = join(fixture, "outside-synthetic");
    writeFileSync(external, Buffer.from("outside stays"));
    symlinkSync(external, payload);
    const report = await scanner().run(plan("cleanup-staging"));
    expect(report.errors).toBeGreaterThan(0);
    expect(
      (await repository.trustedState(swappedId)).stagingCleanedAt,
    ).toBeNull();
    expect(readFileSync(external)).toEqual(Buffer.from("outside stays"));
  });

  it("marks a known DB object MISSING or CORRUPT but never fabricates or overwrites originals", async () => {
    const missingBytes = Buffer.from("missing-object-synthetic");
    const first = await filled(missingBytes);
    await service.finalize(context, Buffer.from(first.publicId, "hex"));
    const firstHash = createHash("sha256").update(missingBytes).digest("hex");
    const firstPath = join(
      root.canonicalPath,
      buildOriginalPath(familyId, firstHash, String(missingBytes.length)),
    );
    rmSync(firstPath); // synthetic fixture fault injection, never a runtime delete API
    const report = await scanner().run(plan("recover"));
    expect(report.dbMissingFinal).toBeGreaterThan(0);
    expect(existsSync(firstPath)).toBe(false);
    const firstObject = await repository.findStorageObject({
      familyId,
      sha256: Buffer.from(firstHash, "hex"),
      byteSize: BigInt(missingBytes.length),
    });
    expect(firstObject?.state).toBe("MISSING");

    const corruptBytes = Buffer.from("corrupt-object-synthetic");
    const second = await filled(corruptBytes);
    await service.finalize(context, Buffer.from(second.publicId, "hex"));
    const secondHash = createHash("sha256").update(corruptBytes).digest("hex");
    const secondPath = join(
      root.canonicalPath,
      buildOriginalPath(familyId, secondHash, String(corruptBytes.length)),
    );
    chmodSync(secondPath, 0o600);
    writeFileSync(secondPath, Buffer.from("x".repeat(corruptBytes.length)));
    chmodSync(secondPath, 0o400);
    await scanner().run(plan("recover"));
    const secondObject = await repository.findStorageObject({
      familyId,
      sha256: Buffer.from(secondHash, "hex"),
      byteSize: BigInt(corruptBytes.length),
    });
    expect(secondObject?.state).toBe("CORRUPT");
    expect(readFileSync(secondPath)).not.toEqual(corruptBytes);
  });

  it("serializes expiry recovery against PATCH and two concurrent reconcilers", async () => {
    const upload = await create(8n);
    const publicId = Buffer.from(upload.publicId, "hex");
    await database.pool.query(
      `UPDATE upload_sessions SET created_at=DATE_SUB(CURRENT_TIMESTAMP(3),INTERVAL 9 DAY),
        updated_at=DATE_SUB(CURRENT_TIMESTAMP(3),INTERVAL 8 DAY),
        expires_at=DATE_SUB(CURRENT_TIMESTAMP(3),INTERVAL 1 DAY)
       WHERE public_id=?`,
      [publicId],
    );
    const [first, second] = await Promise.all([
      scanner().run(plan("recover")),
      scanner().run(plan("recover")),
    ]);
    expect(first.expiredTransitioned + second.expiredTransitioned).toBe(1);
    expect((await repository.trustedState(publicId)).state).toBe("EXPIRED");

    const next = await create(8n);
    const nextId = Buffer.from(next.publicId, "hex");
    let arrived!: () => void;
    const arrival = new Promise<void>((resolve) => {
      arrived = resolve;
    });
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    const blocked = Object.create(repository) as MySqlUploadRepository;
    blocked.systemRevalidate = async (id, expire) => {
      if (id.equals(nextId)) {
        arrived();
        await barrier;
      }
      return repository.systemRevalidate(id, expire);
    };
    const reconciling = scanner(blocked).run(plan("recover"));
    await arrival; // query-arrival seam inside the shared upload mutex
    const patch = mutex.runExclusive(next.publicId, () =>
      service.patch(context, nextId, 0n, Readable.from(["safe"])),
    );
    release();
    await reconciling;
    expect((await patch).committedOffset).toBe(4n);
    expect(root.inspectUploadPayload(familyId, next.publicId)).toBe(4n);
  });

  it("keeps scanner system authority separate from authenticated finalize and abort races", async () => {
    const bytes = Buffer.from("finalize-race-synthetic");
    const staged = await filled(bytes);
    const stagedId = Buffer.from(staged.publicId, "hex");
    const sha = createHash("sha256").update(bytes).digest();
    await repository.beginFinalize({ actor, publicId: stagedId, sha256: sha });
    const scan = scanner().run(plan("recover"));
    const retry = mutex.runExclusive(staged.publicId, () =>
      service.finalize(context, stagedId),
    );
    const [report, completed] = await Promise.all([scan, retry]);
    expect(report.finalizingAutoCompleted).toBe(0);
    expect(completed.state).toBe("COMPLETE");

    const aborted = await create(8n);
    const abortedId = Buffer.from(aborted.publicId, "hex");
    const [beforeAbort] = await Promise.all([
      scanner().run(plan("recover")),
      mutex.runExclusive(aborted.publicId, () =>
        service.abort(context, abortedId),
      ),
    ]);
    expect(beforeAbort.finalizingAutoCompleted).toBe(0);
    expect((await repository.trustedState(abortedId)).state).toBe("ABORTED");
    await scanner().run(plan("cleanup-staging"));
    expect(
      root.inspectUploadPayload.bind(root, familyId, aborted.publicId),
    ).toThrow();
  });

  it("counts future commitment and retained staging once across active, FINALIZING, FAILED and ABORTED states", async () => {
    const baseline = await repository.admissionUsage();
    const active = await create(5n);
    const activeId = Buffer.from(active.publicId, "hex");
    await service.patch(context, activeId, 0n, Readable.from(["abc"]));
    let usage = await repository.admissionUsage();
    expect(usage.reservedFutureBytes - baseline.reservedFutureBytes).toBe(2n);
    expect(usage.retainedStagingBytes - baseline.retainedStagingBytes).toBe(3n);
    expect(usage.outstanding - baseline.outstanding).toBe(5n);
    await repository.abort({ actor, publicId: activeId });
    usage = await repository.admissionUsage();
    expect(usage.reservedFutureBytes - baseline.reservedFutureBytes).toBe(0n);
    expect(usage.retainedStagingBytes - baseline.retainedStagingBytes).toBe(5n);
    expect(root.inspectUploadPayload(familyId, active.publicId)).toBe(3n);
    root.removeUploadPayload(familyId, active.publicId);
    await repository.markCleaned(activeId);
    expect((await repository.admissionUsage()).outstanding).toBe(
      baseline.outstanding,
    );

    const bytes = Buffer.from("frozen-failed-synthetic");
    const frozen = await filled(bytes);
    const frozenId = Buffer.from(frozen.publicId, "hex");
    await repository.beginFinalize({
      actor,
      publicId: frozenId,
      sha256: createHash("sha256").update(bytes).digest(),
    });
    usage = await repository.admissionUsage();
    expect(usage.reservedFutureBytes - baseline.reservedFutureBytes).toBe(0n);
    expect(usage.retainedStagingBytes - baseline.retainedStagingBytes).toBe(
      BigInt(bytes.length),
    );
    await repository.markFailed(frozenId, "STAGING_INTEGRITY_MISMATCH");
    expect(
      (await repository.admissionUsage()).retainedStagingBytes -
        baseline.retainedStagingBytes,
    ).toBe(BigInt(bytes.length));
    root.removeUploadPayload(familyId, frozen.publicId);
    await repository.markCleaned(frozenId);
    expect((await repository.admissionUsage()).outstanding).toBe(
      baseline.outstanding,
    );
  });

  it("retains FINALIZING quota through an ambiguous completion and dedupe loser cleanup failure", async () => {
    const bytes = Buffer.from("phase3f-ambiguous-dedupe-synthetic");
    const baseline = await repository.admissionUsage();
    const pending = await filled(bytes);
    const pendingId = Buffer.from(pending.publicId, "hex");
    const ambiguous = Object.create(repository) as MySqlUploadRepository;
    ambiguous.completeFinalize = async () => {
      throw new CommitOutcomeUnknownError();
    };
    await expect(
      new UploadService(ambiguous, { state: "READ_WRITE", root }).finalize(
        context,
        pendingId,
      ),
    ).rejects.toMatchObject({ code: "OUTCOME_UNKNOWN" });
    expect((await repository.trustedState(pendingId)).state).toBe("FINALIZING");
    expect(
      (await repository.admissionUsage()).retainedStagingBytes -
        baseline.retainedStagingBytes,
    ).toBe(BigInt(bytes.length));
    const first = await service.finalize(context, pendingId);
    expect(first.state).toBe("COMPLETE");
    expect((await repository.admissionUsage()).retainedStagingBytes).toBe(
      baseline.retainedStagingBytes,
    );

    const loser = await filled(bytes);
    const loserId = Buffer.from(loser.publicId, "hex");
    const nativeRemove = root.removeUploadPayload.bind(root);
    root.removeUploadPayload = () => {
      throw new StorageSafetyError("SYNTHETIC_CLEANUP_FAILURE");
    };
    try {
      expect((await service.finalize(context, loserId)).state).toBe("COMPLETE");
    } finally {
      root.removeUploadPayload = nativeRemove;
    }
    expect(
      (await repository.trustedState(loserId)).stagingCleanedAt,
    ).toBeNull();
    expect(
      (await repository.admissionUsage()).retainedStagingBytes -
        baseline.retainedStagingBytes,
    ).toBe(BigInt(bytes.length));
    expect(root.inspectUploadPayload(familyId, loser.publicId)).toBe(
      BigInt(bytes.length),
    );
    await service.finalize(context, loserId);
    expect((await repository.admissionUsage()).retainedStagingBytes).toBe(
      baseline.retainedStagingBytes,
    );
  });

  it("rejects a new upload near 256 GiB until retained terminal staging cleanup is confirmed", async () => {
    const quota = 256n * 1024n ** 3n;
    const connection = await database.pool.getConnection();
    let quotaFamily = "";
    let stagedId: Buffer | undefined;
    let admittedId: Buffer | undefined;
    try {
      const [family] = await connection.query<ResultSetHeader>(
        "INSERT INTO families (name) VALUES (?)",
        [`Phase3F quota synthetic ${suffix}`],
      );
      quotaFamily = String(family.insertId);
      await connection.query(
        "INSERT INTO family_members (family_id,user_id,role) VALUES (?,?,'MEMBER')",
        [quotaFamily, userId],
      );
      const staged = await service.create(context, {
        familyId: quotaFamily,
        publicId: randomBytes(16),
        declaredSize: 2n,
        filename: "quota-synthetic.bin",
        reportedMime: null,
      });
      stagedId = Buffer.from(staged.publicId, "hex");
      await service.patch(context, stagedId, 0n, Readable.from(["ab"]));
      await repository.abort({ actor, publicId: stagedId });
      expect(root.inspectUploadPayload(quotaFamily, staged.publicId)).toBe(2n);
      // Arithmetic-only synthetic DB fixture; never passed to recovery or media reads.
      await connection.query(
        `INSERT INTO storage_objects
           (family_id,sha256,byte_size,state,durable_at,verified_at)
         VALUES (?,? ,?,'AVAILABLE',CURRENT_TIMESTAMP(3),CURRENT_TIMESTAMP(3))`,
        [quotaFamily, randomBytes(32), (quota - 3n).toString()],
      );
      await expect(
        service.create(context, {
          familyId: quotaFamily,
          publicId: randomBytes(16),
          declaredSize: 2n,
          filename: "quota-rejected-synthetic.bin",
          reportedMime: null,
        }),
      ).rejects.toMatchObject({ code: "RATE_LIMITED" });
      root.removeUploadPayload(quotaFamily, staged.publicId);
      await repository.markCleaned(stagedId);
      const admitted = await service.create(context, {
        familyId: quotaFamily,
        publicId: randomBytes(16),
        declaredSize: 2n,
        filename: "quota-admitted-synthetic.bin",
        reportedMime: null,
      });
      admittedId = Buffer.from(admitted.publicId, "hex");
      await service.abort(context, admittedId);
    } finally {
      if (quotaFamily) {
        await connection.query(
          "DELETE FROM upload_sessions WHERE family_id=?",
          [quotaFamily],
        );
        await connection.query(
          "DELETE FROM storage_objects WHERE family_id=?",
          [quotaFamily],
        );
        await connection.query("DELETE FROM family_members WHERE family_id=?", [
          quotaFamily,
        ]);
        await connection.query("DELETE FROM families WHERE id=?", [
          quotaFamily,
        ]);
      }
      connection.release();
    }
    expect(quotaFamily).not.toBe("");
    expect(stagedId).toBeDefined();
    expect(admittedId).toBeDefined();
  });
});
