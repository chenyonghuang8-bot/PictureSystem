import { createHash, randomBytes, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { once } from "node:events";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Readable } from "node:stream";

import type { ResultSetHeader, RowDataPacket } from "mysql2/promise";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  createSessionToken,
  createPasswordEngine,
  hashPassword,
  hashSessionToken,
  normalizeUsername,
} from "../../packages/auth/src/index.js";
import {
  createDatabase,
  MySqlAuthRepository,
  MySqlUploadRepository,
  type Phase1CActor,
} from "../../packages/db/dist/index.js";
import {
  buildUploadPayloadPath,
  buildOriginalPath,
  StorageRoot,
  StorageSafetyError,
} from "../../packages/storage/src/index.js";
import type { AuthContext } from "../../apps/api/src/auth/service.js";
import { AuthService } from "../../apps/api/src/auth/service.js";
import { createApp } from "../../apps/api/src/app.js";
import { UploadMutex } from "../../apps/api/src/uploads/mutex.js";
import { assessStorageStartup } from "../../apps/api/src/uploads/startup.js";
import { UploadService } from "../../apps/api/src/uploads/service.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("PHASE3C3D_DEV_DATABASE_URL_REQUIRED");

describe("Phase 3C/3D MySQL/native upload integration and races", () => {
  const database = createDatabase(databaseUrl);
  const repository = new MySqlUploadRepository(database.pool);
  const suffix = randomUUID().replaceAll("-", "");
  const fixture = mkdtempSync(join(realpathSync(tmpdir()), "phase3c-mysql-"));
  const root = StorageRoot.open(join(fixture, "media"), { initialize: true });
  const service = new UploadService(repository, { state: "READ_WRITE", root });
  const actors = new Map<
    string,
    {
      actor: Phase1CActor;
      context: AuthContext;
      memberId: string;
      sessionToken: string;
    }
  >();
  let familyId = "";
  let crossFamilyId = "";

  beforeAll(async () => {
    const passwordHash = await hashPassword("phase3c-synthetic-password");
    const connection = await database.pool.getConnection();
    try {
      await connection.query("SET SESSION time_zone = '+00:00'");
      const [preflight] = await connection.query<RowDataPacket[]>(
        `SELECT DATABASE() AS db, VERSION() AS mysqlVersion,
          CURRENT_USER() AS account,
          @@GLOBAL.innodb_native_foreign_keys AS nativeFk,
          @@SESSION.foreign_key_checks AS foreignKeyChecks,
          @@GLOBAL.innodb_flush_log_at_trx_commit AS flushAtCommit`,
      );
      const ready = preflight[0];
      if (
        !ready ||
        ready.db !== "family_album_dev" ||
        !String(ready.mysqlVersion).startsWith("9.7.2") ||
        String(ready.account).startsWith("root@") ||
        Number(ready.nativeFk) !== 1 ||
        Number(ready.foreignKeyChecks) !== 1 ||
        Number(ready.flushAtCommit) !== 1
      ) {
        throw new Error("PHASE3C3D_DEV_PREFLIGHT_FAILED");
      }
      await connection.beginTransaction();
      const [family] = await connection.query<ResultSetHeader>(
        "INSERT INTO families (name) VALUES (?)",
        [`Phase 3C synthetic ${suffix}`],
      );
      familyId = String(family.insertId);
      const [crossFamily] = await connection.query<ResultSetHeader>(
        "INSERT INTO families (name) VALUES (?)",
        [`Phase 3C cross-family synthetic ${suffix}`],
      );
      crossFamilyId = String(crossFamily.insertId);
      for (const name of ["owner", "other", "cross", "revoked", "disabled"]) {
        const username = `phase3c_${name}_${suffix}`;
        const [user] = await connection.query<ResultSetHeader>(
          `INSERT INTO users
             (username, username_normalized, password_hash, display_name,
              password_changed_at)
           VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP(3))`,
          [
            username,
            normalizeUsername(username).normalizedBytes,
            passwordHash,
            name,
          ],
        );
        const userId = String(user.insertId);
        const [member] = await connection.query<ResultSetHeader>(
          "INSERT INTO family_members (family_id,user_id,role) VALUES (?,?,'MEMBER')",
          [name === "cross" ? crossFamilyId : familyId, userId],
        );
        const token = createSessionToken();
        const tokenHash = hashSessionToken(token);
        const [session] = await connection.query<ResultSetHeader>(
          `INSERT INTO sessions
             (user_id,token_hash,client_type,authenticated_at,last_seen_at,expires_at)
           VALUES (?,?,'WEB',CURRENT_TIMESTAMP(3),CURRENT_TIMESTAMP(3),
                   DATE_ADD(CURRENT_TIMESTAMP(3),INTERVAL 30 DAY))`,
          [userId, tokenHash],
        );
        const actor = {
          userId,
          sessionId: String(session.insertId),
          tokenHash,
        };
        actors.set(name, {
          actor,
          memberId: String(member.insertId),
          context: authContext(actor, username),
          sessionToken: token,
        });
      }
      await connection.commit();
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
  }, 20_000);

  afterAll(async () => {
    if (!familyId || !crossFamilyId) {
      await database.pool.end();
      root.close();
      rmSync(fixture, { recursive: true, force: true });
      return;
    }
    const connection = await database.pool.getConnection();
    try {
      await connection.query("SET SESSION time_zone = '+00:00'");
      await connection.beginTransaction();
      await connection.query(
        "DELETE FROM upload_sessions WHERE family_id IN (?,?)",
        [familyId, crossFamilyId],
      );
      await connection.query(
        "DELETE FROM storage_objects WHERE family_id IN (?,?)",
        [familyId, crossFamilyId],
      );
      await connection.query(
        "DELETE s FROM sessions s JOIN users u ON u.id=s.user_id WHERE u.username LIKE ?",
        [`phase3c_%_${suffix}`],
      );
      await connection.query(
        "DELETE FROM family_members WHERE family_id IN (?,?)",
        [familyId, crossFamilyId],
      );
      await connection.query("DELETE FROM users WHERE username LIKE ?", [
        `phase3c_%_${suffix}`,
      ]);
      await connection.query("DELETE FROM families WHERE id IN (?,?)", [
        familyId,
        crossFamilyId,
      ]);
      await connection.commit();
      const [remaining] = await connection.query<RowDataPacket[]>(
        "SELECT COUNT(*) AS count FROM upload_sessions WHERE family_id=?",
        [familyId],
      );
      expect(Number(remaining[0]?.count ?? 1)).toBe(0);
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
      await database.pool.end();
      root.close();
      rmSync(fixture, { recursive: true, force: true });
      expect(existsSync(fixture)).toBe(false);
    }
  });

  it("creates, commits durable chunks, resumes from DB offset and keeps full upload UPLOADING", async () => {
    const upload = await create("owner", 10n);
    expect(upload.state).toBe("CREATED");
    const first = await service.patch(
      owner(),
      id(upload.publicId),
      0n,
      Readable.from(["first"]),
    );
    expect(first.committedOffset).toBe(5n);
    expect(
      (await service.head(owner(), id(upload.publicId))).committedOffset,
    ).toBe(5n);
    const complete = await service.patch(
      owner(),
      id(upload.publicId),
      5n,
      Readable.from(["tail!"]),
    );
    expect(complete).toMatchObject({
      committedOffset: 10n,
      state: "UPLOADING",
    });
    expect(
      readFileSync(
        join(
          root.canonicalPath,
          buildUploadPayloadPath(familyId, upload.publicId),
        ),
      ),
    ).toEqual(Buffer.from("firsttail!"));
    await service.abort(owner(), id(upload.publicId));
  });

  it("serializes two PATCH requests at the same expected offset", async () => {
    const upload = await create("owner", 8n);
    const mutex = new UploadMutex();
    const results = await Promise.allSettled([
      mutex.runExclusive(upload.publicId, () =>
        service.patch(
          owner(),
          id(upload.publicId),
          0n,
          Readable.from(["aaaa"]),
        ),
      ),
      mutex.runExclusive(upload.publicId, () =>
        service.patch(
          owner(),
          id(upload.publicId),
          0n,
          Readable.from(["bbbb"]),
        ),
      ),
    ]);
    expect(
      results.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    const rejected = results.filter(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );
    expect(rejected).toHaveLength(1);
    expect(rejected[0]?.reason).toMatchObject({
      code: "OFFSET_MISMATCH",
      currentOffset: 4n,
    });
    const trusted = await repository.trustedState(id(upload.publicId));
    expect(trusted.committedOffset).toBe(4n);
    const bytes = readFileSync(
      join(
        root.canonicalPath,
        buildUploadPayloadPath(familyId, upload.publicId),
      ),
    );
    expect(["aaaa", "bbbb"]).toContain(bytes.toString());
    await service.abort(owner(), id(upload.publicId));
  });

  it("serializes abort before a waiting PATCH and never advances an aborted upload", async () => {
    const upload = await create("owner", 4n);
    const mutex = new UploadMutex();
    let releaseAbort!: () => void;
    let abortEntered!: () => void;
    const release = new Promise<void>((resolve) => {
      releaseAbort = resolve;
    });
    const entered = new Promise<void>((resolve) => {
      abortEntered = resolve;
    });
    const abort = mutex.runExclusive(upload.publicId, async () => {
      abortEntered();
      await release;
      return service.abort(owner(), id(upload.publicId));
    });
    await entered;
    const patch = mutex.runExclusive(upload.publicId, () =>
      service.patch(owner(), id(upload.publicId), 0n, Readable.from(["data"])),
    );
    releaseAbort();
    await abort;
    await expect(patch).rejects.toMatchObject({
      code: "UPLOAD_STATE_CONFLICT",
    });
    const trusted = await repository.trustedState(id(upload.publicId));
    expect(trusted).toMatchObject({ state: "ABORTED", committedOffset: 0n });
  });

  it("revalidates member and session after a body barrier before writing", async () => {
    for (const [name, revoke] of [
      ["disabled", false],
      ["revoked", true],
    ] as const) {
      const upload = await create(name, 4n);
      let signalBodyRead!: () => void;
      const bodyRead = new Promise<void>((resolve) => {
        signalBodyRead = resolve;
      });
      const body = new Readable({
        read() {
          signalBodyRead();
        },
      });
      const patch = service.patch(
        actors.get(name)!.context,
        id(upload.publicId),
        0n,
        body,
      );
      await bodyRead;
      if (revoke) {
        await database.pool.query(
          "UPDATE sessions SET revoked_at=CURRENT_TIMESTAMP(3), revoke_reason='LOGOUT' WHERE id=?",
          [actors.get(name)!.actor.sessionId],
        );
      } else {
        await database.pool.query(
          "UPDATE family_members SET disabled_at=CURRENT_TIMESTAMP(3) WHERE id=?",
          [actors.get(name)!.memberId],
        );
      }
      body.push(Buffer.from("data"));
      body.push(null);
      await expect(patch).rejects.toMatchObject({ code: "UNAUTHENTICATED" });
      expect(
        (await repository.trustedState(id(upload.publicId))).committedOffset,
      ).toBe(0n);
    }
  });

  it("hides uploads from same-family and cross-family members and expires active receipts", async () => {
    const upload = await create("owner", 2n);
    await expect(
      service.head(actors.get("other")!.context, id(upload.publicId)),
    ).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    await expect(
      service.head(actors.get("cross")!.context, id(upload.publicId)),
    ).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    await database.pool.query(
      `UPDATE upload_sessions
          SET created_at=DATE_SUB(CURRENT_TIMESTAMP(3),INTERVAL 8 DAY),
              updated_at=DATE_SUB(CURRENT_TIMESTAMP(3),INTERVAL 8 DAY),
              expires_at=DATE_SUB(CURRENT_TIMESTAMP(3),INTERVAL 1 SECOND)
        WHERE public_id=?`,
      [id(upload.publicId)],
    );
    await expect(
      service.head(owner(), id(upload.publicId)),
    ).rejects.toMatchObject({
      code: "UPLOAD_EXPIRED",
    });
    expect(await service.status(owner(), id(upload.publicId))).toMatchObject({
      state: "EXPIRED",
      committedOffset: 0n,
    });
  });

  it("rejects an expired session on a later upload operation", async () => {
    const upload = await create("owner", 2n);
    const ownerSession = actors.get("owner")!.actor.sessionId;
    await database.pool.query(
      `UPDATE sessions
          SET created_at=DATE_SUB(CURRENT_TIMESTAMP(3),INTERVAL 31 DAY),
              authenticated_at=DATE_SUB(CURRENT_TIMESTAMP(3),INTERVAL 31 DAY),
              last_seen_at=DATE_SUB(CURRENT_TIMESTAMP(3),INTERVAL 1 DAY),
              expires_at=DATE_SUB(CURRENT_TIMESTAMP(3),INTERVAL 1 SECOND)
        WHERE id=?`,
      [ownerSession],
    );
    try {
      await expect(
        service.head(owner(), id(upload.publicId)),
      ).rejects.toMatchObject({
        code: "UNAUTHENTICATED",
      });
    } finally {
      await database.pool.query(
        `UPDATE sessions
            SET authenticated_at=CURRENT_TIMESTAMP(3),
                last_seen_at=CURRENT_TIMESTAMP(3),
                expires_at=DATE_ADD(CURRENT_TIMESTAMP(3),INTERVAL 30 DAY)
          WHERE id=?`,
        [ownerSession],
      );
      await service.abort(owner(), id(upload.publicId));
    }
  });

  it("rejects non-whitelisted failure codes before issuing SQL", async () => {
    await expect(
      repository.markFailed(randomBytes(16), "raw errno/path" as never),
    ).rejects.toThrow("UPLOAD_FAILURE_CODE_INVALID");
  });

  it("persists only a controlled failure code", async () => {
    const upload = await create("owner", 2n);
    await repository.markFailed(id(upload.publicId), "STORAGE_WRITE_FAILED");
    const failed = await repository.trustedState(id(upload.publicId));
    expect(failed).toMatchObject({
      state: "FAILED",
      failureCode: "STORAGE_WRITE_FAILED",
    });
    root.removeUploadPayload(failed.familyId, failed.publicId);
    await repository.markCleaned(id(upload.publicId));
  });

  it("durably finalizes one original, keeps an independent receipt and retries COMPLETE", async () => {
    const bytes = Buffer.from("phase3d synthetic original alpha");
    const upload = await create("owner", BigInt(bytes.length));
    await service.patch(
      owner(),
      id(upload.publicId),
      0n,
      Readable.from([bytes]),
    );
    const first = await service.finalize(owner(), id(upload.publicId));
    expect(first).toMatchObject({
      uploadId: upload.publicId,
      state: "COMPLETE",
    });
    expect(first).not.toHaveProperty("sha256");
    expect(first).not.toHaveProperty("storageObjectId");
    const repeated = await service.finalize(owner(), id(upload.publicId));
    expect(repeated).toEqual(first);
    expect(
      (await service.head(owner(), id(upload.publicId))).committedOffset,
    ).toBe(BigInt(bytes.length));
    expect((await service.status(owner(), id(upload.publicId))).state).toBe(
      "COMPLETE",
    );
    const trusted = await repository.trustedState(id(upload.publicId));
    expect(trusted.state).toBe("COMPLETE");
    expect(trusted.storageObjectId).not.toBeNull();
    expect(trusted.stagingCleanedAt).not.toBeNull();
    const sha = createHash("sha256").update(bytes).digest("hex");
    expect(
      root.verifyOriginal(familyId, sha, String(bytes.length)).sha256,
    ).toEqual(Buffer.from(sha, "hex"));
    expect(
      existsSync(
        join(
          root.canonicalPath,
          buildUploadPayloadPath(familyId, upload.publicId),
        ),
      ),
    ).toBe(false);
  });

  it("serializes same-family exact dedupe and never shares an original across families", async () => {
    const bytes = Buffer.from("phase3d simultaneous family-scoped original");
    const sha = createHash("sha256").update(bytes).digest();
    const first = await create("owner", BigInt(bytes.length));
    const second = await create("other", BigInt(bytes.length));
    await service.patch(
      owner(),
      id(first.publicId),
      0n,
      Readable.from([bytes]),
    );
    await service.patch(
      actors.get("other")!.context,
      id(second.publicId),
      0n,
      Readable.from([bytes]),
    );
    let arrivals = 0;
    let releaseBoth!: () => void;
    const bothArrived = new Promise<void>((resolve) => {
      releaseBoth = resolve;
    });
    const barrierRepository = Object.create(
      repository,
    ) as MySqlUploadRepository;
    barrierRepository.inspect = async (input) => {
      if (
        input.publicId.equals(id(first.publicId)) ||
        input.publicId.equals(id(second.publicId))
      ) {
        arrivals += 1;
        if (arrivals === 2) releaseBoth();
        await bothArrived;
      }
      return repository.inspect(input);
    };
    const racing = new UploadService(barrierRepository, {
      state: "READ_WRITE",
      root,
    });
    const [a, b] = await Promise.all([
      racing.finalize(owner(), id(first.publicId)),
      racing.finalize(actors.get("other")!.context, id(second.publicId)),
    ]);
    expect(arrivals).toBe(2);
    expect(a.state).toBe("COMPLETE");
    expect(b.state).toBe("COMPLETE");
    const one = await repository.trustedState(id(first.publicId));
    const two = await repository.trustedState(id(second.publicId));
    expect(one.storageObjectId).toBe(two.storageObjectId);
    const [rows] = await database.pool.query<RowDataPacket[]>(
      "SELECT COUNT(*) AS count FROM storage_objects WHERE family_id=? AND sha256=? AND byte_size=?",
      [familyId, sha, String(bytes.length)],
    );
    expect(Number(rows[0]?.count)).toBe(1);
    expect(
      existsSync(
        join(
          root.canonicalPath,
          buildOriginalPath(
            familyId,
            sha.toString("hex"),
            String(bytes.length),
          ),
        ),
      ),
    ).toBe(true);

    const cross = await service.create(actors.get("cross")!.context, {
      familyId: crossFamilyId,
      publicId: randomBytes(16),
      declaredSize: BigInt(bytes.length),
      filename: "synthetic-cross.bin",
      reportedMime: "application/octet-stream",
    });
    await service.patch(
      actors.get("cross")!.context,
      id(cross.publicId),
      0n,
      Readable.from([bytes]),
    );
    await service.finalize(actors.get("cross")!.context, id(cross.publicId));
    const otherObject = await repository.trustedState(id(cross.publicId));
    expect(otherObject.storageObjectId).not.toBe(one.storageObjectId);
    expect(
      existsSync(
        join(
          root.canonicalPath,
          buildOriginalPath(
            crossFamilyId,
            sha.toString("hex"),
            String(bytes.length),
          ),
        ),
      ),
    ).toBe(true);
  });

  it("retains a durable published candidate after a known DB completion failure and safely retries", async () => {
    const bytes = Buffer.from("phase3d candidate after synthetic DB failure");
    const sha = createHash("sha256").update(bytes).digest("hex");
    const upload = await create("owner", BigInt(bytes.length));
    await service.patch(
      owner(),
      id(upload.publicId),
      0n,
      Readable.from([bytes]),
    );
    const failing = Object.create(repository) as MySqlUploadRepository;
    failing.completeFinalize = async () => {
      throw new Error("SYNTHETIC_COMPLETION_FAILURE");
    };
    const brokenService = new UploadService(failing, {
      state: "READ_WRITE",
      root,
    });
    await expect(
      brokenService.finalize(owner(), id(upload.publicId)),
    ).rejects.toMatchObject({ code: "STORAGE_UNAVAILABLE" });
    expect((await repository.trustedState(id(upload.publicId))).state).toBe(
      "FINALIZING",
    );
    expect(
      root.verifyOriginal(familyId, sha, String(bytes.length)).byteSize,
    ).toBe(BigInt(bytes.length));
    await service.finalize(owner(), id(upload.publicId));
    expect((await repository.trustedState(id(upload.publicId))).state).toBe(
      "COMPLETE",
    );
  });

  it("revalidates a disabled uploader at T-complete and leaves only a recoverable candidate", async () => {
    const bytes = Buffer.from("phase3d member disable before receipt commit");
    const upload = await create("other", BigInt(bytes.length));
    await service.patch(
      actors.get("other")!.context,
      id(upload.publicId),
      0n,
      Readable.from([bytes]),
    );
    const actor = actors.get("other")!;
    const intervening = Object.create(repository) as MySqlUploadRepository;
    intervening.completeFinalize = async (input) => {
      await database.pool.query(
        "UPDATE family_members SET disabled_at=CURRENT_TIMESTAMP(3) WHERE id=?",
        [actor.memberId],
      );
      return repository.completeFinalize(input);
    };
    const guarded = new UploadService(intervening, {
      state: "READ_WRITE",
      root,
    });
    try {
      await expect(
        guarded.finalize(actor.context, id(upload.publicId)),
      ).rejects.toMatchObject({ code: "UNAUTHENTICATED" });
      const pending = await repository.trustedState(id(upload.publicId));
      expect(pending.state).toBe("FINALIZING");
      expect(pending.storageObjectId).toBeNull();
    } finally {
      await database.pool.query(
        "UPDATE family_members SET disabled_at=NULL WHERE id=?",
        [actor.memberId],
      );
    }
    await service.finalize(actor.context, id(upload.publicId));
    expect((await repository.trustedState(id(upload.publicId))).state).toBe(
      "COMPLETE",
    );
  });

  it("rechecks member/session authorization after a real MySQL lock wait before intent/publish", async () => {
    for (const [name, kind] of [
      ["other", "member"],
      ["owner", "session"],
    ] as const) {
      const bytes = Buffer.from(`phase3d locked ${kind} synthetic payload`);
      const holder = actors.get(name)!;
      const upload = await create(name, BigInt(bytes.length));
      await service.patch(
        holder.context,
        id(upload.publicId),
        0n,
        Readable.from([bytes]),
      );
      const lock = await database.pool.getConnection();
      await lock.query("SET SESSION time_zone = '+00:00'");
      await lock.beginTransaction();
      let committed = false;
      try {
        if (kind === "member") {
          await lock.query(
            "SELECT id FROM family_members WHERE id=? FOR UPDATE",
            [holder.memberId],
          );
        } else {
          await lock.query("SELECT id FROM sessions WHERE id=? FOR UPDATE", [
            holder.actor.sessionId,
          ]);
        }
        let signalArrived!: () => void;
        const arrived = new Promise<void>((resolve) => {
          signalArrived = resolve;
        });
        const signaled = Object.create(repository) as MySqlUploadRepository;
        signaled.inspect = async (input) => {
          signalArrived();
          return repository.inspect(input);
        };
        const guarded = new UploadService(signaled, {
          state: "READ_WRITE",
          root,
        });
        const pending = guarded.finalize(holder.context, id(upload.publicId));
        await arrived;
        if (kind === "member") {
          await lock.query(
            "UPDATE family_members SET disabled_at=CURRENT_TIMESTAMP(3) WHERE id=?",
            [holder.memberId],
          );
        } else {
          await lock.query(
            "UPDATE sessions SET revoked_at=CURRENT_TIMESTAMP(3), revoke_reason='LOGOUT' WHERE id=?",
            [holder.actor.sessionId],
          );
        }
        await lock.commit();
        committed = true;
        await expect(pending).rejects.toMatchObject({
          code: "UNAUTHENTICATED",
        });
        expect((await repository.trustedState(id(upload.publicId))).state).toBe(
          "UPLOADING",
        );
        expect(
          existsSync(
            join(
              root.canonicalPath,
              buildOriginalPath(
                familyId,
                createHash("sha256").update(bytes).digest("hex"),
                String(bytes.length),
              ),
            ),
          ),
        ).toBe(false);
      } finally {
        if (!committed) await lock.rollback();
        lock.release();
        if (kind === "member") {
          await database.pool.query(
            "UPDATE family_members SET disabled_at=NULL WHERE id=?",
            [holder.memberId],
          );
        } else {
          await database.pool.query(
            "UPDATE sessions SET revoked_at=NULL, revoke_reason=NULL WHERE id=?",
            [holder.actor.sessionId],
          );
        }
        await service.abort(holder.context, id(upload.publicId));
      }
    }
  });

  it("rejects T-complete when absolute session expiry crosses a storage-object lock wait", async () => {
    const bytes = Buffer.from(
      "phase3d absolute expiry during storage row wait",
    );
    const sha = createHash("sha256").update(bytes).digest();
    const first = await create("owner", BigInt(bytes.length));
    await service.patch(
      owner(),
      id(first.publicId),
      0n,
      Readable.from([bytes]),
    );
    await service.finalize(owner(), id(first.publicId));
    const second = await create("owner", BigInt(bytes.length));
    await service.patch(
      owner(),
      id(second.publicId),
      0n,
      Readable.from([bytes]),
    );
    const held = await database.pool.getConnection();
    await held.query("SET SESSION time_zone = '+00:00'");
    await held.beginTransaction();
    let committed = false;
    try {
      const [heldRows] = await held.query<RowDataPacket[]>(
        "SELECT id FROM storage_objects WHERE family_id=? AND sha256=? AND byte_size=? FOR UPDATE",
        [familyId, sha, String(bytes.length)],
      );
      expect(heldRows).toHaveLength(1);
      const adjust = await database.pool.getConnection();
      try {
        await adjust.query("SET SESSION time_zone = '+00:00'");
        await adjust.query(
          `UPDATE sessions SET expires_at=DATE_ADD(CURRENT_TIMESTAMP(3), INTERVAL 2 SECOND)
           WHERE id=?`,
          [actors.get("owner")!.actor.sessionId],
        );
        const [deadline] = await adjust.query<RowDataPacket[]>(
          `SELECT TIMESTAMPDIFF(MICROSECOND,CURRENT_TIMESTAMP(3),expires_at)
             AS remainingMicros FROM sessions WHERE id=?`,
          [actors.get("owner")!.actor.sessionId],
        );
        expect(Number(deadline[0]?.remainingMicros)).toBeGreaterThan(0);
        expect(Number(deadline[0]?.remainingMicros)).toBeLessThanOrEqual(
          2_000_000,
        );
      } finally {
        adjust.release();
      }
      let signalComplete!: () => void;
      const entered = new Promise<void>((resolve) => {
        signalComplete = resolve;
      });
      const signaled = Object.create(repository) as MySqlUploadRepository;
      signaled.completeFinalize = async (input) => {
        signalComplete();
        return repository.completeFinalize(input);
      };
      const racing = new UploadService(signaled, { state: "READ_WRITE", root });
      const pending = racing.finalize(owner(), id(second.publicId));
      let settledBeforeUnlock = false;
      void pending.then(
        () => {
          settledBeforeUnlock = true;
        },
        () => {
          settledBeforeUnlock = true;
        },
      );
      let arrivalTimer: NodeJS.Timeout | undefined;
      try {
        await Promise.race([
          entered,
          new Promise<never>((_resolve, reject) => {
            arrivalTimer = setTimeout(
              () => reject(new Error("T_COMPLETE_NOT_REACHED")),
              10_000,
            );
          }),
        ]);
      } finally {
        if (arrivalTimer) clearTimeout(arrivalTimer);
      }
      await held.query("SELECT SLEEP(2.2)");
      expect(settledBeforeUnlock).toBe(false);
      const checkDeadline = await database.pool.getConnection();
      try {
        await checkDeadline.query("SET SESSION time_zone = '+00:00'");
        const [deadline] = await checkDeadline.query<RowDataPacket[]>(
          `SELECT TIMESTAMPDIFF(MICROSECOND,CURRENT_TIMESTAMP(3),expires_at)
             AS remainingMicros FROM sessions WHERE id=?`,
          [actors.get("owner")!.actor.sessionId],
        );
        expect(Number(deadline[0]?.remainingMicros)).toBeLessThanOrEqual(0);
      } finally {
        checkDeadline.release();
      }
      await held.commit();
      committed = true;
      await expect(pending).rejects.toMatchObject({ code: "UNAUTHENTICATED" });
      const receipt = await repository.trustedState(id(second.publicId));
      expect(receipt.state).toBe("FINALIZING");
      expect(receipt.storageObjectId).toBeNull();
    } finally {
      if (!committed) await held.rollback();
      held.release();
      const restore = await database.pool.getConnection();
      try {
        await restore.query("SET SESSION time_zone = '+00:00'");
        await restore.query(
          `UPDATE sessions SET expires_at=DATE_ADD(CURRENT_TIMESTAMP(3), INTERVAL 30 DAY)
            WHERE id=?`,
          [actors.get("owner")!.actor.sessionId],
        );
      } finally {
        restore.release();
      }
    }
    await service.finalize(owner(), id(second.publicId));
    expect((await repository.trustedState(id(second.publicId))).state).toBe(
      "COMPLETE",
    );
  }, 15_000);

  it("rejects revoke at T-complete, preserving the published candidate without a receipt", async () => {
    const bytes = Buffer.from("phase3d session revoke before receipt commit");
    const upload = await create("owner", BigInt(bytes.length));
    const holder = actors.get("owner")!;
    await service.patch(
      holder.context,
      id(upload.publicId),
      0n,
      Readable.from([bytes]),
    );
    const intervening = Object.create(repository) as MySqlUploadRepository;
    intervening.completeFinalize = async (input) => {
      await database.pool.query(
        "UPDATE sessions SET revoked_at=CURRENT_TIMESTAMP(3), revoke_reason='LOGOUT' WHERE id=?",
        [holder.actor.sessionId],
      );
      return repository.completeFinalize(input);
    };
    const guarded = new UploadService(intervening, {
      state: "READ_WRITE",
      root,
    });
    try {
      await expect(
        guarded.finalize(holder.context, id(upload.publicId)),
      ).rejects.toMatchObject({ code: "UNAUTHENTICATED" });
      const pending = await repository.trustedState(id(upload.publicId));
      expect(pending.state).toBe("FINALIZING");
      expect(pending.storageObjectId).toBeNull();
      expect(
        existsSync(
          join(
            root.canonicalPath,
            buildOriginalPath(
              familyId,
              createHash("sha256").update(bytes).digest("hex"),
              String(bytes.length),
            ),
          ),
        ),
      ).toBe(true);
    } finally {
      await database.pool.query(
        "UPDATE sessions SET revoked_at=NULL, revoke_reason=NULL WHERE id=?",
        [holder.actor.sessionId],
      );
    }
  });

  it("serializes abort/finalize and PATCH/finalize under one upload mutex", async () => {
    const bytes = Buffer.from("phase3d mutex bytes");
    const first = await create("owner", BigInt(bytes.length));
    await service.patch(
      owner(),
      id(first.publicId),
      0n,
      Readable.from([bytes]),
    );
    const mutex = new UploadMutex();
    const [final, abort] = await Promise.allSettled([
      mutex.runExclusive(first.publicId, () =>
        service.finalize(owner(), id(first.publicId)),
      ),
      mutex.runExclusive(first.publicId, () =>
        service.abort(owner(), id(first.publicId)),
      ),
    ]);
    expect(final.status).toBe("fulfilled");
    expect(abort.status).toBe("rejected");
    expect(abort.status === "rejected" && abort.reason.code).toBe(
      "UPLOAD_STATE_CONFLICT",
    );
    expect((await repository.trustedState(id(first.publicId))).state).toBe(
      "COMPLETE",
    );

    const second = await create("owner", BigInt(bytes.length));
    await service.patch(
      owner(),
      id(second.publicId),
      0n,
      Readable.from([bytes]),
    );
    const [aborted, deniedFinal] = await Promise.allSettled([
      mutex.runExclusive(second.publicId, () =>
        service.abort(owner(), id(second.publicId)),
      ),
      mutex.runExclusive(second.publicId, () =>
        service.finalize(owner(), id(second.publicId)),
      ),
    ]);
    expect(aborted.status).toBe("fulfilled");
    expect(deniedFinal.status).toBe("rejected");
    expect((await repository.trustedState(id(second.publicId))).state).toBe(
      "ABORTED",
    );

    const third = await create("owner", BigInt(bytes.length));
    await service.patch(
      owner(),
      id(third.publicId),
      0n,
      Readable.from([bytes]),
    );
    const [completed, stalePatch] = await Promise.allSettled([
      mutex.runExclusive(third.publicId, () =>
        service.finalize(owner(), id(third.publicId)),
      ),
      mutex.runExclusive(third.publicId, () =>
        service.patch(owner(), id(third.publicId), 0n, Readable.from(["x"])),
      ),
    ]);
    expect(completed.status).toBe("fulfilled");
    expect(stalePatch.status).toBe("rejected");
    expect((await repository.trustedState(id(third.publicId))).state).toBe(
      "COMPLETE",
    );
  });

  it("keeps a frozen intent and intact staging when readiness fails before publish", async () => {
    const bytes = Buffer.from("phase3d synthetic failure before publish");
    const sha = createHash("sha256").update(bytes).digest("hex");
    const upload = await create("owner", BigInt(bytes.length));
    await service.patch(
      owner(),
      id(upload.publicId),
      0n,
      Readable.from([bytes]),
    );
    const failing = Object.create(repository) as MySqlUploadRepository;
    failing.assertFinalizeDurability = async () => {
      throw new Error("SYNTHETIC_DURABILITY_UNAVAILABLE");
    };
    const guarded = new UploadService(failing, { state: "READ_WRITE", root });
    await expect(
      guarded.finalize(owner(), id(upload.publicId)),
    ).rejects.toMatchObject({ code: "STORAGE_UNAVAILABLE" });
    expect((await repository.trustedState(id(upload.publicId))).state).toBe(
      "FINALIZING",
    );
    expect(
      root.hashUploadPayload(familyId, upload.publicId, true).sha256,
    ).toEqual(Buffer.from(sha, "hex"));
    expect(
      existsSync(
        join(
          root.canonicalPath,
          buildOriginalPath(familyId, sha, String(bytes.length)),
        ),
      ),
    ).toBe(false);
    await service.finalize(owner(), id(upload.publicId));
    expect((await repository.trustedState(id(upload.publicId))).state).toBe(
      "COMPLETE",
    );
  });

  it("rejects same-size staging modification after intent without publishing", async () => {
    const bytes = Buffer.from("phase3d frozen synthetic staging bytes");
    const upload = await create("owner", BigInt(bytes.length));
    await service.patch(
      owner(),
      id(upload.publicId),
      0n,
      Readable.from([bytes]),
    );
    const failing = Object.create(repository) as MySqlUploadRepository;
    failing.assertFinalizeDurability = async () => {
      throw new Error("SYNTHETIC_BEFORE_PUBLISH");
    };
    await expect(
      new UploadService(failing, { state: "READ_WRITE", root }).finalize(
        owner(),
        id(upload.publicId),
      ),
    ).rejects.toMatchObject({
      code: "STORAGE_UNAVAILABLE",
    });
    const altered = Buffer.from(bytes);
    altered[0] = altered[0] === 0x61 ? 0x62 : 0x61;
    writeFileSync(
      join(
        root.canonicalPath,
        buildUploadPayloadPath(familyId, upload.publicId),
      ),
      altered,
    );
    await expect(
      service.finalize(owner(), id(upload.publicId)),
    ).rejects.toMatchObject({ code: "STORAGE_UNAVAILABLE" });
    const failed = await repository.trustedState(id(upload.publicId));
    expect(failed).toMatchObject({
      state: "FAILED",
      failureCode: "FINALIZE_HASH_MISMATCH",
    });
    expect(
      existsSync(
        join(
          root.canonicalPath,
          buildOriginalPath(
            familyId,
            createHash("sha256").update(bytes).digest("hex"),
            String(bytes.length),
          ),
        ),
      ),
    ).toBe(false);
  });

  it("rejects an actual staging size mismatch and never publishes an original", async () => {
    const bytes = Buffer.from("phase3d synthetic wrong actual file length");
    const upload = await create("owner", BigInt(bytes.length));
    await service.patch(
      owner(),
      id(upload.publicId),
      0n,
      Readable.from([bytes]),
    );
    root.truncateUploadPayload(
      familyId,
      upload.publicId,
      BigInt(bytes.length - 1),
    );
    await expect(
      service.finalize(owner(), id(upload.publicId)),
    ).rejects.toMatchObject({ code: "STORAGE_UNAVAILABLE" });
    expect(await repository.trustedState(id(upload.publicId))).toMatchObject({
      state: "FAILED",
      failureCode: "FINALIZE_SIZE_MISMATCH",
    });
    expect(
      existsSync(
        join(
          root.canonicalPath,
          buildOriginalPath(
            familyId,
            createHash("sha256").update(bytes).digest("hex"),
            String(bytes.length),
          ),
        ),
      ),
    ).toBe(false);
  });

  it("re-verifies a final candidate after a post-rename synthetic durability failure", async () => {
    const bytes = Buffer.from("phase3d synthetic publish outcome failure");
    const sha = createHash("sha256").update(bytes).digest("hex");
    const upload = await create("owner", BigInt(bytes.length));
    await service.patch(
      owner(),
      id(upload.publicId),
      0n,
      Readable.from([bytes]),
    );
    const nativePublish = root.publishOriginal.bind(root);
    root.publishOriginal = (input) => {
      nativePublish(input);
      throw new StorageSafetyError("DURABILITY_NOT_CONFIRMED");
    };
    try {
      await expect(
        service.finalize(owner(), id(upload.publicId)),
      ).rejects.toMatchObject({ code: "STORAGE_UNAVAILABLE" });
    } finally {
      root.publishOriginal = nativePublish;
    }
    expect((await repository.trustedState(id(upload.publicId))).state).toBe(
      "FINALIZING",
    );
    expect(
      root.verifyOriginal(familyId, sha, String(bytes.length)).byteSize,
    ).toBe(BigInt(bytes.length));
    await service.finalize(owner(), id(upload.publicId));
    expect((await repository.trustedState(id(upload.publicId))).state).toBe(
      "COMPLETE",
    );
  });

  it("retains staging when exclusive publish fails before rename, then retries without overwrite", async () => {
    const bytes = Buffer.from("phase3d synthetic pre-rename failure");
    const upload = await create("owner", BigInt(bytes.length));
    await service.patch(
      owner(),
      id(upload.publicId),
      0n,
      Readable.from([bytes]),
    );
    const nativePublish = root.publishOriginal.bind(root);
    root.publishOriginal = () => {
      throw new StorageSafetyError("SYNTHETIC_PUBLISH_FAILURE");
    };
    try {
      await expect(
        service.finalize(owner(), id(upload.publicId)),
      ).rejects.toMatchObject({ code: "STORAGE_UNAVAILABLE" });
    } finally {
      root.publishOriginal = nativePublish;
    }
    expect((await repository.trustedState(id(upload.publicId))).state).toBe(
      "FINALIZING",
    );
    expect(
      root.hashUploadPayload(familyId, upload.publicId, true).byteSize,
    ).toBe(BigInt(bytes.length));
    await service.finalize(owner(), id(upload.publicId));
    expect((await repository.trustedState(id(upload.publicId))).state).toBe(
      "COMPLETE",
    );
  });

  it("links a second receipt after an existing object survives a known completion failure", async () => {
    const bytes = Buffer.from("phase3d existing object incomplete receipt");
    const first = await create("owner", BigInt(bytes.length));
    await service.patch(
      owner(),
      id(first.publicId),
      0n,
      Readable.from([bytes]),
    );
    await service.finalize(owner(), id(first.publicId));
    const second = await create("other", BigInt(bytes.length));
    await service.patch(
      actors.get("other")!.context,
      id(second.publicId),
      0n,
      Readable.from([bytes]),
    );
    const failing = Object.create(repository) as MySqlUploadRepository;
    failing.completeFinalize = async () => {
      throw new Error("SYNTHETIC_RECEIPT_FAILURE");
    };
    await expect(
      new UploadService(failing, { state: "READ_WRITE", root }).finalize(
        actors.get("other")!.context,
        id(second.publicId),
      ),
    ).rejects.toMatchObject({ code: "STORAGE_UNAVAILABLE" });
    const pending = await repository.trustedState(id(second.publicId));
    expect(pending.state).toBe("FINALIZING");
    expect(pending.storageObjectId).toBeNull();
    await service.finalize(actors.get("other")!.context, id(second.publicId));
    expect(
      (await repository.trustedState(id(second.publicId))).storageObjectId,
    ).toBe((await repository.trustedState(id(first.publicId))).storageObjectId);
  });

  it("keeps COMPLETE after loser staging cleanup failure and safely retries exact cleanup", async () => {
    const bytes = Buffer.from(
      "phase3d synthetic loser staging cleanup failure",
    );
    const first = await create("owner", BigInt(bytes.length));
    await service.patch(
      owner(),
      id(first.publicId),
      0n,
      Readable.from([bytes]),
    );
    await service.finalize(owner(), id(first.publicId));
    const second = await create("owner", BigInt(bytes.length));
    await service.patch(
      owner(),
      id(second.publicId),
      0n,
      Readable.from([bytes]),
    );
    const nativeRemove = root.removeUploadPayload.bind(root);
    root.removeUploadPayload = () => {
      throw new StorageSafetyError("SYNTHETIC_CLEANUP_FAILURE");
    };
    try {
      const result = await service.finalize(owner(), id(second.publicId));
      expect(result.state).toBe("COMPLETE");
    } finally {
      root.removeUploadPayload = nativeRemove;
    }
    const receipt = await repository.trustedState(id(second.publicId));
    expect(receipt.state).toBe("COMPLETE");
    expect(receipt.stagingCleanedAt).toBeNull();
    expect(receipt.storageObjectId).toBe(
      (await repository.trustedState(id(first.publicId))).storageObjectId,
    );
    await service.finalize(owner(), id(second.publicId));
    expect(
      (await repository.trustedState(id(second.publicId))).stagingCleanedAt,
    ).not.toBeNull();
    expect(
      existsSync(
        join(
          root.canonicalPath,
          buildUploadPayloadPath(familyId, second.publicId),
        ),
      ),
    ).toBe(false);
  });

  it("recovers an authenticated FINALIZING receipt after SIGKILL between original publish and DB completion", async () => {
    const bytes = Buffer.from("phase3d child process crash candidate bytes");
    const holder = actors.get("owner")!;
    const [crashFamilyRow] = await database.pool.query<ResultSetHeader>(
      "INSERT INTO families (name) VALUES (?)",
      [`Phase3F crash synthetic ${suffix}`],
    );
    const crashFamilyId = String(crashFamilyRow.insertId);
    await database.pool.query(
      "INSERT INTO family_members (family_id,user_id,role) VALUES (?,?,'MEMBER')",
      [crashFamilyId, holder.actor.userId],
    );
    const publicId = randomBytes(16);
    const created = await repository.createUpload({
      actor: holder.actor,
      familyId: crashFamilyId,
      publicId,
      originalFilename: "phase3d-synthetic-crash.bin",
      reportedMime: null,
      declaredSize: BigInt(bytes.length),
    });
    const crashMedia = join(fixture, "crash-media");
    const childRoot = StorageRoot.open(crashMedia, { initialize: true });
    const markerId = childRoot.markerId;
    childRoot.createUploadPayload(crashFamilyId, created.publicId, bytes);
    childRoot.close();
    await repository.advanceOffset({
      actor: holder.actor,
      publicId,
      expectedOffset: 0n,
      durableBytes: BigInt(bytes.length),
    });
    const childScript = resolve(
      import.meta.dirname,
      "fixtures/phase3d-kill-child.mjs",
    );
    const child = spawn(
      process.execPath,
      [
        "--env-file=.env",
        "--import",
        "tsx",
        childScript,
        crashMedia,
        markerId,
        created.publicId,
        holder.actor.userId,
        holder.actor.sessionId,
      ],
      { cwd: process.cwd(), stdio: ["ignore", "ignore", "ignore", "ipc"] },
    );
    let recoveredRoot: StorageRoot | undefined;
    try {
      const phase = await new Promise<{ phase: string; category?: string }>(
        (resolvePhase, rejectPhase) => {
          const timer = setTimeout(
            () => rejectPhase(new Error("CHILD_CRASH_PHASE_TIMEOUT")),
            15_000,
          );
          child.on("message", (message: unknown) => {
            const value = message as { phase?: unknown };
            if (typeof value.phase !== "string") return;
            clearTimeout(timer);
            resolvePhase(value as { phase: string; category?: string });
          });
          child.once("exit", () => {
            clearTimeout(timer);
            rejectPhase(new Error("CHILD_EXITED_BEFORE_PUBLISH_SIGNAL"));
          });
        },
      );
      expect(phase).toEqual({ phase: "PUBLISHED_BEFORE_DB_COMPLETION" });
      const exited = once(child, "exit");
      expect(child.kill("SIGKILL")).toBe(true);
      await exited;
      const pending = await repository.trustedState(publicId);
      expect(pending.state).toBe("FINALIZING");
      expect(pending.storageObjectId).toBeNull();
      const sha = createHash("sha256").update(bytes).digest("hex");
      recoveredRoot = StorageRoot.open(crashMedia, {
        initialize: false,
        expectedMarkerId: markerId,
      });
      expect(
        recoveredRoot.verifyOriginal(crashFamilyId, sha, String(bytes.length))
          .byteSize,
      ).toBe(BigInt(bytes.length));
      const mutex = new UploadMutex();
      const startup = await assessStorageStartup(
        repository,
        { state: "READ_WRITE", root: recoveredRoot },
        mutex,
        { familyScope: crashFamilyId },
      );
      expect(startup.capability.state).toBe("READ_WRITE");
      expect(
        startup.report?.knownRecoverableFinalizingCandidates,
      ).toBeGreaterThanOrEqual(1);
      expect(startup.report?.orphanFinalCandidates).toBe(0);
      const authService = await AuthService.create(
        new MySqlAuthRepository(database.pool),
        createPasswordEngine(),
      );
      expect(await authService.authenticate(holder.sessionToken)).toBeTruthy();
      const app = createApp({
        authService,
        uploadService: new UploadService(repository, startup.capability),
        publicApiOrigin: "https://localhost:4000",
        trustedOrigins: new Set(["https://localhost:3000"]),
        uploadMutex: mutex,
      });
      try {
        const response = await app.inject({
          method: "POST",
          url: `/api/v1/uploads/${created.publicId}/finalize`,
          headers: {
            cookie: `__Host-family_session=${holder.sessionToken}`,
            origin: "https://localhost:3000",
            "content-type": "application/json",
          },
          payload: "{}",
        });
        expect(response.statusCode).toBe(200);
        expect(response.json().state).toBe("COMPLETE");
      } finally {
        await app.close();
      }
      expect(
        (await repository.trustedState(publicId)).storageObjectId,
      ).not.toBeNull();
      expect(
        recoveredRoot.verifyOriginal(crashFamilyId, sha, String(bytes.length))
          .byteSize,
      ).toBe(BigInt(bytes.length));
      expect(
        existsSync(
          join(
            recoveredRoot.canonicalPath,
            buildUploadPayloadPath(crashFamilyId, created.publicId),
          ),
        ),
      ).toBe(false);
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        const exited = once(child, "exit");
        child.kill("SIGKILL");
        await exited;
      }
      recoveredRoot?.close();
      await database.pool.query(
        "DELETE FROM upload_sessions WHERE family_id=?",
        [crashFamilyId],
      );
      await database.pool.query(
        "DELETE FROM storage_objects WHERE family_id=?",
        [crashFamilyId],
      );
      await database.pool.query(
        "DELETE FROM family_members WHERE family_id=?",
        [crashFamilyId],
      );
      await database.pool.query("DELETE FROM families WHERE id=?", [
        crashFamilyId,
      ]);
    }
  }, 25_000);

  async function create(name: string, size: bigint) {
    const publicId = randomBytes(16);
    return service.create(actors.get(name)!.context, {
      familyId,
      publicId,
      declaredSize: size,
      filename: `../${name}/synthetic.bin`,
      reportedMime: "application/octet-stream",
    });
  }

  function owner() {
    return actors.get("owner")!.context;
  }
});

function id(value: string) {
  return Buffer.from(value, "hex");
}

function authContext(actor: Phase1CActor, username: string): AuthContext {
  const now = new Date();
  return {
    identity: {
      sessionId: actor.sessionId,
      userId: actor.userId,
      username,
      displayName: null,
      passwordHash: "synthetic",
      clientType: "WEB",
      authenticatedAt: now,
      createdAt: now,
      lastSeenAt: now,
      expiresAt: new Date(now.getTime() + 30 * 24 * 60 * 60_000),
      revokedAt: null,
      disabledAt: null,
      serverNow: now,
    },
    tokenHash: actor.tokenHash,
  };
}
