import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  lstatSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";

import type {
  PoolConnection,
  ResultSetHeader,
  RowDataPacket,
} from "mysql2/promise";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AlbumRepositoryError as ApiAlbumRepositoryError } from "../../packages/db/dist/index.js";

import {
  AlbumRepositoryError,
  assertMigrationReadiness,
  createDatabase,
  MySqlAlbumRepository,
} from "../../packages/db/src/index.js";
import { albumRaceBarrier } from "../../packages/db/src/album-race-barrier-test-helper.js";
import type { AlbumRepositoryTestEvent } from "../../packages/db/src/album-repository-test-hooks.js";
import {
  OriginalReader,
  StorageRoot,
} from "../../packages/storage/src/index.js";
import { createApp } from "../../apps/api/src/app.js";
import type { AlbumService } from "../../apps/api/src/albums/service.js";
import type { AuthService } from "../../apps/api/src/auth/service.js";
import { OriginalDownloadLimiter } from "../../apps/api/src/original-download/limiter.js";
import {
  OriginalDownloadService,
  type OriginalDownloadReader,
} from "../../apps/api/src/original-download/service.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("PHASE6D3_DEV_DATABASE_URL_REQUIRED");

type Identity = {
  userId: string;
  memberId: string;
  sessionId: string;
  tokenHash: Buffer;
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function controlledDownloadReader(
  bytes: Buffer,
  options: { holdCleanup?: boolean; events?: string[] } = {},
) {
  const entered = deferred<void>();
  const verification = deferred<void>();
  const cleanupStarted = deferred<void>();
  const cleanupCanSettle = deferred<void>();
  if (!options.holdCleanup) cleanupCanSettle.resolve();
  const ledger = {
    readerEntered: 0,
    verificationReleased: 0,
    readCount: 0,
    cancelApiCalled: 0,
    cleanupStarted: 0,
    cleanupSettled: 0,
  };
  const reader: OriginalDownloadReader = {
    async withVerifiedDownload(_identity, { signal }, callback) {
      ledger.readerEntered += 1;
      options.events?.push("verification-enter");
      entered.resolve();
      await verification.promise;
      ledger.verificationReleased += 1;
      signal.throwIfAborted();
      let finished = false;
      let cancelled = false;
      try {
        return await callback({
          readNext: async () => {
            ledger.readCount += 1;
            finished = true;
            return { done: false, bytes, final: true } as const;
          },
          cancel: async () => {
            if (!cancelled) {
              cancelled = true;
              ledger.cancelApiCalled += 1;
            }
          },
        });
      } finally {
        void finished;
        void cancelled;
        ledger.cleanupStarted += 1;
        options.events?.push("cleanup-start");
        cleanupStarted.resolve();
        await cleanupCanSettle.promise;
        ledger.cleanupSettled += 1;
        options.events?.push("cleanup-settle");
      }
    },
  };
  return {
    reader,
    ledger,
    entered: entered.promise,
    releaseVerification: () => verification.resolve(),
    cleanupStarted: cleanupStarted.promise,
    releaseCleanup: () => cleanupCanSettle.resolve(),
  };
}

class ObservedOriginalDownloadLimiter extends OriginalDownloadLimiter {
  constructor(private readonly events: string[]) {
    super();
  }

  override tryAcquire(familyId: string, memberId: string) {
    const lease = super.tryAcquire(familyId, memberId);
    if (!lease) return null;
    return {
      release: () => {
        this.events.push("capacity-release");
        lease.release();
      },
    };
  }
}

function serviceRepository(
  source: MySqlAlbumRepository,
  onRecheckError?: (error: AlbumRepositoryError) => void,
  onRecheckSuccess?: () => void,
) {
  return {
    prepareOriginalDownload: async (
      ...args: Parameters<MySqlAlbumRepository["prepareOriginalDownload"]>
    ) => {
      try {
        return await source.prepareOriginalDownload(...args);
      } catch (error) {
        if (error instanceof AlbumRepositoryError) {
          throw new ApiAlbumRepositoryError(error.reason);
        }
        throw error;
      }
    },
    recheckOriginalDownload: async (
      ...args: Parameters<MySqlAlbumRepository["recheckOriginalDownload"]>
    ) => {
      try {
        const record = await source.recheckOriginalDownload(...args);
        onRecheckSuccess?.();
        return record;
      } catch (error) {
        if (error instanceof AlbumRepositoryError) {
          onRecheckError?.(error);
          throw new ApiAlbumRepositoryError(error.reason);
        }
        throw error;
      }
    },
  };
}

describe.sequential("Phase 6D3 original download", () => {
  const database = createDatabase(databaseUrl);
  const repository = new MySqlAlbumRepository(database.pool);
  const suffix = randomUUID().replaceAll("-", "");
  const fixtureBase = mkdtempSync(
    join(realpathSync(tmpdir()), "phase6d3-download-"),
  );
  const mediaRoot = join(fixtureBase, "media");
  const root = StorageRoot.open(mediaRoot, { initialize: true });
  const bytes = Buffer.from(`phase-6d3-synthetic-original-${suffix}`);
  const sha256Hex = createHash("sha256").update(bytes).digest("hex");
  const uploadPublicId = randomBytes(16);
  const uploadId = uploadPublicId.toString("hex");
  let reader: OriginalReader;
  let originalPath = "";
  let familyId = "";
  let otherFamilyId = "";
  let owner = emptyIdentity();
  let viewer = emptyIdentity();
  let superAdmin = emptyIdentity();
  let outsider = emptyIdentity();
  let albumId = "";
  let hiddenAlbumId = "";
  let storageObjectId = "";
  let mediaId = "";

  beforeAll(async () => {
    const connection = await database.pool.getConnection();
    try {
      await preflight(connection);
      familyId = await insertFamily(connection, `Phase 6D3 ${suffix}`);
      otherFamilyId = await insertFamily(
        connection,
        `Phase 6D3 outsider ${suffix}`,
      );
      owner = await insertIdentity(
        connection,
        familyId,
        suffix,
        "owner",
        "ADMIN",
      );
      viewer = await insertIdentity(
        connection,
        familyId,
        suffix,
        "viewer",
        "MEMBER",
      );
      superAdmin = await insertIdentity(
        connection,
        familyId,
        suffix,
        "super",
        "SUPER_ADMIN",
      );
      outsider = await insertIdentity(
        connection,
        otherFamilyId,
        suffix,
        "outsider",
        "SUPER_ADMIN",
      );
      albumId = await insertAlbum(
        connection,
        familyId,
        owner.memberId,
        "visible",
      );
      hiddenAlbumId = await insertAlbum(
        connection,
        familyId,
        owner.memberId,
        "hidden",
      );
      await putView(connection, familyId, albumId, viewer.memberId, true);
      root.createUploadPayload(familyId, uploadId, bytes);
      const published = root.publishOriginal({
        familyId,
        uploadId,
        sha256Hex,
        byteSize: String(bytes.length),
      });
      originalPath = join(mediaRoot, published.relativePath);
      const inserted = await insertMedia(
        connection,
        familyId,
        owner.memberId,
        uploadPublicId,
        Buffer.from(sha256Hex, "hex"),
        bytes.length,
      );
      storageObjectId = inserted.storageObjectId;
      mediaId = inserted.mediaId;
      await connection.query(
        "INSERT INTO album_media (family_id,album_id,media_id) VALUES (?,?,?)",
        [familyId, albumId, mediaId],
      );
      reader = OriginalReader.open({
        mediaRoot,
        expectedMarkerId: root.markerId,
      });
    } finally {
      connection.release();
    }
  });

  afterAll(async () => {
    reader?.close();
    for (const fixtureFamilyId of [familyId, otherFamilyId]) {
      for (const table of [
        "album_media",
        "album_members",
        "media_items",
        "upload_sessions",
        "storage_objects",
        "albums",
      ]) {
        await database.pool.query(`DELETE FROM ${table} WHERE family_id=?`, [
          fixtureFamilyId,
        ]);
      }
      await database.pool.query(
        "DELETE s FROM sessions s JOIN family_members m ON m.user_id=s.user_id WHERE m.family_id=?",
        [fixtureFamilyId],
      );
      const [users] = await database.pool.query<RowDataPacket[]>(
        "SELECT CAST(user_id AS CHAR) AS userId FROM family_members WHERE family_id=?",
        [fixtureFamilyId],
      );
      await database.pool.query(
        "DELETE FROM family_members WHERE family_id=?",
        [fixtureFamilyId],
      );
      for (const user of users) {
        await database.pool.query("DELETE FROM users WHERE id=?", [
          String(user.userId),
        ]);
      }
      await database.pool.query("DELETE FROM families WHERE id=?", [
        fixtureFamilyId,
      ]);
    }
    const [residue] = await database.pool.query<RowDataPacket[]>(
      "SELECT COUNT(*) AS count FROM families WHERE id IN (?,?)",
      [familyId, otherFamilyId],
    );
    expect(String(residue[0]?.count)).toBe("0");
    await database.pool.end();
    root.close();
    expect(relative(realpathSync(tmpdir()), fixtureBase)).toMatch(
      /^phase6d3-download-[^/]+$/u,
    );
    rmSync(fixtureBase, { recursive: true, force: true });
  });

  it("uses real 6D1 verification and preserves original and canonical rows", async () => {
    const beforeFile = fileSnapshot(originalPath);
    const beforeRows = await canonicalSnapshot();
    const service = new OriginalDownloadService(repository, reader);
    const server = createApp({
      authService: fixedAuth(viewer),
      albumService: {} as AlbumService,
      originalDownloadService: service,
      trustedOrigins: new Set(["https://family.test"]),
    });
    const response = await server.inject({
      method: "GET",
      url: `/api/v1/albums/${albumId}/media/${mediaId}/download/original`,
      headers: {
        cookie: "__Host-family_session=synthetic",
        range: "bytes=0-3",
      },
    });
    expect(response.statusCode).toBe(200);
    expect(response.rawPayload).toEqual(bytes);
    expect(response.headers["accept-ranges"]).toBe("none");
    expect(response.headers["content-range"]).toBeUndefined();
    expect(fileSnapshot(originalPath)).toEqual(beforeFile);
    expect(await canonicalSnapshot()).toEqual(beforeRows);
    await server.close();
  });

  it("enforces selected-album ACL, placement, BLOCKED and SUPER_ADMIN boundaries", async () => {
    await expect(
      repository.prepareOriginalDownload({
        actor: actor(owner),
        albumId,
        mediaId,
      }),
    ).resolves.toMatchObject({
      familyId,
      albumId,
      actorMemberId: owner.memberId,
      mediaId,
    });
    await expect(
      repository.prepareOriginalDownload({
        actor: actor(superAdmin),
        albumId: hiddenAlbumId,
        mediaId,
      }),
    ).rejects.toMatchObject({ reason: "NOT_FOUND" });
    await expect(
      repository.prepareOriginalDownload({
        actor: actor(viewer),
        albumId: hiddenAlbumId,
        mediaId,
      }),
    ).rejects.toMatchObject({ reason: "NOT_FOUND" });
    await expect(
      repository.prepareOriginalDownload({
        actor: actor(outsider),
        albumId,
        mediaId,
      }),
    ).rejects.toMatchObject({ reason: "NOT_FOUND" });

    await database.pool.query(
      "DELETE FROM album_media WHERE family_id=? AND album_id=? AND media_id=?",
      [familyId, albumId, mediaId],
    );
    try {
      await expect(
        repository.prepareOriginalDownload({
          actor: actor(viewer),
          albumId,
          mediaId,
        }),
      ).rejects.toMatchObject({ reason: "NOT_FOUND" });
    } finally {
      await database.pool.query(
        "INSERT INTO album_media (family_id,album_id,media_id) VALUES (?,?,?)",
        [familyId, albumId, mediaId],
      );
    }

    await database.pool.query(
      "UPDATE media_items SET processing_state='BLOCKED',last_failure_code='MALFORMED_MEDIA' WHERE id=?",
      [mediaId],
    );
    await expect(
      repository.prepareOriginalDownload({
        actor: actor(viewer),
        albumId,
        mediaId,
      }),
    ).rejects.toMatchObject({ reason: "NOT_FOUND" });
    await database.pool.query(
      "UPDATE media_items SET processing_state='READY',last_failure_code=NULL WHERE id=?",
      [mediaId],
    );
  });

  it("uses detected MIME only for the current metadata generation", async () => {
    const current = await repository.prepareOriginalDownload({
      actor: actor(viewer),
      albumId,
      mediaId,
    });
    expect(current.detectedMime).toBe("image/jpeg");

    await database.pool.query(
      "UPDATE media_items SET processing_state='PARTIAL',generation=2,metadata_generation=1 WHERE id=?",
      [mediaId],
    );
    const stale = await repository.prepareOriginalDownload({
      actor: actor(viewer),
      albumId,
      mediaId,
    });
    expect(stale.detectedMime).toBeNull();

    await database.pool.query(
      "UPDATE media_items SET generation=1,metadata_generation=1,detected_mime=NULL WHERE id=?",
      [mediaId],
    );
    const unknown = await repository.prepareOriginalDownload({
      actor: actor(viewer),
      albumId,
      mediaId,
    });
    expect(unknown.detectedMime).toBeNull();
    await database.pool.query(
      "UPDATE media_items SET detected_mime='image/jpeg',processing_state='READY' WHERE id=?",
      [mediaId],
    );
  });

  it.each([
    [
      "ACL revoke",
      "NOT_FOUND",
      404,
      async (connection: PoolConnection) =>
        putView(connection, familyId, albumId, viewer.memberId, false),
      async (connection: PoolConnection) =>
        putView(connection, familyId, albumId, viewer.memberId, true),
    ],
    [
      "placement removal",
      "NOT_FOUND",
      404,
      async (connection: PoolConnection) =>
        connection.query(
          "DELETE FROM album_media WHERE family_id=? AND album_id=? AND media_id=?",
          [familyId, albumId, mediaId],
        ),
      async (connection: PoolConnection) =>
        connection.query(
          "INSERT INTO album_media (family_id,album_id,media_id) VALUES (?,?,?)",
          [familyId, albumId, mediaId],
        ),
    ],
    [
      "member disable",
      "UNAUTHENTICATED",
      401,
      async (connection: PoolConnection) =>
        connection.query(
          "UPDATE family_members SET disabled_at=CURRENT_TIMESTAMP(3) WHERE id=?",
          [viewer.memberId],
        ),
      async (connection: PoolConnection) =>
        connection.query(
          "UPDATE family_members SET disabled_at=NULL WHERE id=?",
          [viewer.memberId],
        ),
    ],
    [
      "member leave",
      "UNAUTHENTICATED",
      401,
      async (connection: PoolConnection) =>
        connection.query(
          "UPDATE family_members SET left_at=CURRENT_TIMESTAMP(3) WHERE id=?",
          [viewer.memberId],
        ),
      async (connection: PoolConnection) =>
        connection.query("UPDATE family_members SET left_at=NULL WHERE id=?", [
          viewer.memberId,
        ]),
    ],
    [
      "session revoke",
      "UNAUTHENTICATED",
      401,
      async (connection: PoolConnection) =>
        connection.query(
          "UPDATE sessions SET revoked_at=CURRENT_TIMESTAMP(3),revoke_reason='USER_REVOKE' WHERE id=?",
          [viewer.sessionId],
        ),
      async (connection: PoolConnection) =>
        connection.query(
          "UPDATE sessions SET revoked_at=NULL,revoke_reason=NULL WHERE id=?",
          [viewer.sessionId],
        ),
    ],
    [
      "storage missing",
      "SERVICE_UNAVAILABLE",
      503,
      async (connection: PoolConnection) =>
        connection.query(
          "UPDATE storage_objects SET state='MISSING' WHERE id=?",
          [storageObjectId],
        ),
      async (connection: PoolConnection) =>
        connection.query(
          "UPDATE storage_objects SET state='AVAILABLE' WHERE id=?",
          [storageObjectId],
        ),
    ],
    [
      "storage corrupt",
      "SERVICE_UNAVAILABLE",
      503,
      async (connection: PoolConnection) =>
        connection.query(
          "UPDATE storage_objects SET state='CORRUPT' WHERE id=?",
          [storageObjectId],
        ),
      async (connection: PoolConnection) =>
        connection.query(
          "UPDATE storage_objects SET state='AVAILABLE' WHERE id=?",
          [storageObjectId],
        ),
    ],
  ] as const)(
    "rejects a committed %s through the HTTP download boundary",
    async (_name, expectedReason, expectedStatus, mutate, restore) => {
      const events: string[] = [];
      const proveCleanupOrder = _name === "ACL revoke";
      const controlled = controlledDownloadReader(bytes, {
        holdCleanup: proveCleanupOrder,
        events,
      });
      const limiter = new ObservedOriginalDownloadLimiter(events);
      let recheckCalls = 0;
      let recheckReason: string | undefined;
      const observedRepository = serviceRepository(repository, (error) => {
        recheckCalls += 1;
        recheckReason = error.reason;
      });
      const server = createApp({
        authService: fixedAuth(viewer),
        albumService: {} as AlbumService,
        originalDownloadService: new OriginalDownloadService(
          observedRepository,
          controlled.reader,
          limiter,
        ),
        trustedOrigins: new Set(["https://family.test"]),
      });
      const pending = server.inject({
        method: "GET",
        url: `/api/v1/albums/${albumId}/media/${mediaId}/download/original`,
        headers: { cookie: "__Host-family_session=synthetic" },
      });
      try {
        await controlled.entered;
        expect(limiter.snapshot()).toEqual({ active: 1, activeMembers: 1 });
        await committedFamilyMutation(
          database.pool,
          familyId,
          mutate as (connection: PoolConnection) => Promise<unknown>,
        );
        controlled.releaseVerification();
        if (proveCleanupOrder) {
          await controlled.cleanupStarted;
          expect(controlled.ledger.cleanupSettled).toBe(0);
          expect(limiter.snapshot()).toEqual({ active: 1, activeMembers: 1 });
          expect(events).not.toContain("capacity-release");
          controlled.releaseCleanup();
        }
        const response = await pending;
        expect(recheckCalls).toBe(1);
        expect(recheckReason).toBe(expectedReason);
        expect(response.statusCode).toBe(expectedStatus);
        expect(response.statusCode).not.toBe(200);
        expect(response.headers["content-disposition"]).toBeUndefined();
        expect(response.rawPayload.equals(bytes)).toBe(false);
        expect(response.json()).toMatchObject({ code: expectedReason });
        expect(controlled.ledger).toEqual({
          readerEntered: 1,
          verificationReleased: 1,
          readCount: 0,
          cancelApiCalled: 0,
          cleanupStarted: 1,
          cleanupSettled: 1,
        });
        expect(limiter.snapshot()).toEqual({ active: 0, activeMembers: 0 });
        if (proveCleanupOrder) {
          expect(events.indexOf("cleanup-settle")).toBeLessThan(
            events.indexOf("capacity-release"),
          );
        }
      } finally {
        controlled.releaseVerification();
        controlled.releaseCleanup();
        await pending.catch(() => undefined);
        await committedFamilyMutation(
          database.pool,
          familyId,
          restore as (connection: PoolConnection) => Promise<unknown>,
        );
        await server.close();
      }
    },
  );

  it("proves recheck-first ordering through a complete HTTP transfer", async () => {
    const validated = albumRaceBarrier(
      {
        stage: "ORIGINAL_DOWNLOAD_VALIDATED_BEFORE_COMMIT",
        operation: "ORIGINAL_DOWNLOAD_RECHECK",
      },
      { pause: true },
    );
    const events: string[] = [];
    const controlled = controlledDownloadReader(bytes, {
      holdCleanup: true,
      events,
    });
    let server: ReturnType<typeof createApp> | undefined;
    try {
      const winningRepository = new MySqlAlbumRepository(database.pool, {
        testHook: validated.hook,
      });
      const limiter = new ObservedOriginalDownloadLimiter(events);
      server = createApp({
        authService: fixedAuth(viewer),
        albumService: {} as AlbumService,
        originalDownloadService: new OriginalDownloadService(
          serviceRepository(winningRepository, undefined, () =>
            events.push("second-auth-commit"),
          ),
          controlled.reader,
          limiter,
        ),
        trustedOrigins: new Set(["https://family.test"]),
      });
      const pending = server.inject({
        method: "GET",
        url: `/api/v1/albums/${albumId}/media/${mediaId}/download/original`,
        headers: { cookie: "__Host-family_session=synthetic" },
      });
      await controlled.entered;
      expect(limiter.snapshot()).toEqual({ active: 1, activeMembers: 1 });
      controlled.releaseVerification();
      const validatedEvent = await validated.wait();
      const secondAuthConnectionId = requiredConnectionId(validatedEvent);
      events.push("second-auth-precommit");
      const mutationDispatched = deferred<number>();
      let mutationLockAcquired = false;
      let mutationCommitted = false;
      let serverLockWaitObserved = false;
      const revoke = committedFamilyMutation(
        database.pool,
        familyId,
        async (connection) => {
          mutationLockAcquired = true;
          await putView(connection, familyId, albumId, viewer.memberId, false);
        },
        (connectionId) => mutationDispatched.resolve(connectionId),
        () => {
          mutationCommitted = true;
          events.push("mutation-commit");
        },
        () => {
          serverLockWaitObserved = true;
          events.push("mutation-lock-wait-observed");
        },
      );
      const mutationConnectionId = await mutationDispatched.promise;
      expect(mutationConnectionId).not.toBe(secondAuthConnectionId);
      expect(serverLockWaitObserved).toBe(true);
      expect(mutationLockAcquired).toBe(false);
      expect(mutationCommitted).toBe(false);
      validated.release();
      await controlled.cleanupStarted;
      expect(controlled.ledger.cleanupSettled).toBe(0);
      expect(limiter.snapshot()).toEqual({ active: 1, activeMembers: 1 });
      expect(events).not.toContain("capacity-release");
      controlled.releaseCleanup();
      const response = await pending;
      await revoke;
      expect(response.statusCode).toBe(200);
      expect(response.rawPayload).toEqual(bytes);
      expect(controlled.ledger).toEqual({
        readerEntered: 1,
        verificationReleased: 1,
        readCount: 1,
        cancelApiCalled: 0,
        cleanupStarted: 1,
        cleanupSettled: 1,
      });
      expect(limiter.snapshot()).toEqual({ active: 0, activeMembers: 0 });
      expect(events.indexOf("mutation-lock-wait-observed")).toBeLessThan(
        events.indexOf("second-auth-commit"),
      );
      expect(events.indexOf("second-auth-commit")).toBeLessThan(
        events.indexOf("mutation-commit"),
      );
      expect(events.indexOf("cleanup-settle")).toBeLessThan(
        events.indexOf("capacity-release"),
      );
      const next = await server.inject({
        method: "GET",
        url: `/api/v1/albums/${albumId}/media/${mediaId}/download/original`,
        headers: { cookie: "__Host-family_session=synthetic" },
      });
      expect(next.statusCode).toBe(404);
      expect(controlled.ledger.readerEntered).toBe(1);
    } finally {
      validated.release();
      controlled.releaseVerification();
      controlled.releaseCleanup();
      await server?.close().catch(() => undefined);
      await committedFamilyMutation(database.pool, familyId, (connection) =>
        putView(connection, familyId, albumId, viewer.memberId, true),
      );
    }
  });

  async function canonicalSnapshot() {
    const [rows] = await database.pool.query<RowDataPacket[]>(
      `SELECT
         (SELECT LOWER(HEX(sha256)) FROM storage_objects WHERE id=?) AS sha256Hex,
         (SELECT CAST(byte_size AS CHAR) FROM storage_objects WHERE id=?) AS byteSize,
         (SELECT CAST(source_upload_id AS CHAR) FROM media_items WHERE id=?) AS sourceUploadId,
         (SELECT processing_state FROM media_items WHERE id=?) AS processingState,
         (SELECT COUNT(*) FROM album_media WHERE family_id=? AND media_id=?) AS placements,
         (SELECT COUNT(*) FROM derived_assets WHERE family_id=? AND media_id=?) AS derivedCount`,
      [
        storageObjectId,
        storageObjectId,
        mediaId,
        mediaId,
        familyId,
        mediaId,
        familyId,
        mediaId,
      ],
    );
    return rows[0];
  }
});

function emptyIdentity(): Identity {
  return {
    userId: "",
    memberId: "",
    sessionId: "",
    tokenHash: Buffer.alloc(32),
  };
}

function actor(identity: Identity) {
  return {
    userId: identity.userId,
    sessionId: identity.sessionId,
    tokenHash: identity.tokenHash,
  };
}

function fixedAuth(identity: Identity) {
  return {
    authenticate: async () => ({
      identity: { userId: identity.userId, sessionId: identity.sessionId },
      tokenHash: identity.tokenHash,
    }),
  } as unknown as AuthService;
}

async function committedFamilyMutation(
  pool: ReturnType<typeof createDatabase>["pool"],
  familyId: string,
  mutate: (connection: PoolConnection) => Promise<unknown>,
  onFamilyLockDispatched?: (connectionId: number) => void,
  onCommitted?: () => void,
  onServerLockWaitObserved?: (connectionId: number) => void,
) {
  const connection = await pool.getConnection();
  let transactionStarted = false;
  try {
    const connectionId = await mysqlConnectionId(connection);
    await connection.beginTransaction();
    transactionStarted = true;
    if (onServerLockWaitObserved) {
      const [timeoutRows] = await connection.query<RowDataPacket[]>(
        "SELECT @@SESSION.innodb_lock_wait_timeout AS lockWaitTimeout",
      );
      const previousLockWaitTimeout = Number(timeoutRows[0]?.lockWaitTimeout);
      if (!Number.isSafeInteger(previousLockWaitTimeout)) {
        throw new Error("MYSQL_LOCK_WAIT_TIMEOUT_INVALID");
      }
      await connection.query("SET SESSION innodb_lock_wait_timeout=1");
      try {
        await connection.query(
          "SELECT id FROM families WHERE id=? FOR UPDATE",
          [familyId],
        );
        throw new Error("MYSQL_LOCK_WAIT_EXPECTED");
      } catch (error) {
        if (!isMysqlLockWaitTimeout(error)) throw error;
        onServerLockWaitObserved(connectionId);
      } finally {
        await connection.query("SET SESSION innodb_lock_wait_timeout=?", [
          previousLockWaitTimeout,
        ]);
      }
    }
    const familyLock = connection.query(
      "SELECT id FROM families WHERE id=? FOR UPDATE",
      [familyId],
    );
    void familyLock.catch(() => undefined);
    onFamilyLockDispatched?.(connectionId);
    await familyLock;
    await mutate(connection);
    await connection.commit();
    transactionStarted = false;
    onCommitted?.();
  } catch (error) {
    if (transactionStarted) await connection.rollback().catch(() => undefined);
    throw error;
  } finally {
    connection.release();
  }
}

function requiredConnectionId(event: AlbumRepositoryTestEvent) {
  const connectionId = event.connectionId;
  if (!Number.isSafeInteger(connectionId) || Number(connectionId) <= 0) {
    throw new Error("SECOND_AUTH_CONNECTION_ID_MISSING");
  }
  return Number(connectionId);
}

async function mysqlConnectionId(connection: PoolConnection) {
  const [rows] = await connection.query<RowDataPacket[]>(
    "SELECT CONNECTION_ID() AS connectionId",
  );
  const connectionId = Number(rows[0]?.connectionId);
  if (!Number.isSafeInteger(connectionId) || connectionId <= 0) {
    throw new Error("MYSQL_CONNECTION_ID_INVALID");
  }
  return connectionId;
}

function isMysqlLockWaitTimeout(error: unknown) {
  if (!error || typeof error !== "object") return false;
  const mysqlError = error as { code?: string; errno?: number };
  return (
    mysqlError.code === "ER_LOCK_WAIT_TIMEOUT" && mysqlError.errno === 1205
  );
}

async function preflight(connection: PoolConnection) {
  const [rows] = await connection.query<RowDataPacket[]>(
    `SELECT DATABASE() AS db, VERSION() AS version, CURRENT_USER() AS account,
            @@GLOBAL.innodb_native_foreign_keys AS nativeFk,
            @@SESSION.foreign_key_checks AS foreignKeyChecks`,
  );
  const row = rows[0];
  if (
    row?.db !== "family_album_dev" ||
    !String(row.version).startsWith("9.7.2") ||
    String(row.account).split("@")[0]?.toLowerCase() === "root" ||
    String(row.nativeFk) !== "1" ||
    String(row.foreignKeyChecks) !== "1"
  ) {
    throw new Error("PHASE6D3_DEV_PREFLIGHT_FAILED");
  }
  await assertMigrationReadiness(connection);
}

async function insertFamily(connection: PoolConnection, name: string) {
  const [row] = await connection.query<ResultSetHeader>(
    "INSERT INTO families (name) VALUES (?)",
    [name],
  );
  return String(row.insertId);
}

async function insertIdentity(
  connection: PoolConnection,
  familyId: string,
  suffix: string,
  label: string,
  role: "SUPER_ADMIN" | "ADMIN" | "MEMBER",
): Promise<Identity> {
  const username = `p6d3_${label}_${suffix}`;
  const [user] = await connection.query<ResultSetHeader>(
    `INSERT INTO users
      (username,username_normalized,password_hash,display_name,password_changed_at)
     VALUES (?,?,?,?,CURRENT_TIMESTAMP(3))`,
    [username, Buffer.from(username), "synthetic-not-used", `P6D3 ${label}`],
  );
  const [member] = await connection.query<ResultSetHeader>(
    "INSERT INTO family_members (family_id,user_id,role) VALUES (?,?,?)",
    [familyId, String(user.insertId), role],
  );
  const tokenHash = randomBytes(32);
  const sessionTime = new Date(Date.now() - 60_000);
  const [session] = await connection.query<ResultSetHeader>(
    `INSERT INTO sessions
      (user_id,token_hash,client_type,authenticated_at,last_seen_at,expires_at,created_at)
     VALUES (?,?,'WEB',?,?,DATE_ADD(CURRENT_TIMESTAMP(3),INTERVAL 1 DAY),?)`,
    [String(user.insertId), tokenHash, sessionTime, sessionTime, sessionTime],
  );
  return {
    userId: String(user.insertId),
    memberId: String(member.insertId),
    sessionId: String(session.insertId),
    tokenHash,
  };
}

async function insertAlbum(
  connection: PoolConnection,
  familyId: string,
  ownerMemberId: string,
  name: string,
) {
  const [row] = await connection.query<ResultSetHeader>(
    "INSERT INTO albums (family_id,owner_member_id,name,visibility) VALUES (?,?,?,'CUSTOM')",
    [familyId, ownerMemberId, name],
  );
  return String(row.insertId);
}

async function putView(
  connection:
    Pick<PoolConnection, "query"> | ReturnType<typeof createDatabase>["pool"],
  familyId: string,
  albumId: string,
  memberId: string,
  enabled: boolean,
) {
  await connection.query(
    `INSERT INTO album_members (family_id,album_id,member_id,can_view)
     VALUES (?,?,?,?) AS new
     ON DUPLICATE KEY UPDATE can_view=new.can_view`,
    [familyId, albumId, memberId, enabled],
  );
}

async function insertMedia(
  connection: PoolConnection,
  familyId: string,
  memberId: string,
  publicId: Buffer,
  sha: Buffer,
  byteSize: number,
) {
  const [object] = await connection.query<ResultSetHeader>(
    `INSERT INTO storage_objects
      (family_id,sha256,byte_size,key_version,state,durable_at,verified_at)
     VALUES (?,?,?,1,'AVAILABLE',CURRENT_TIMESTAMP(3),CURRENT_TIMESTAMP(3))`,
    [familyId, sha, byteSize],
  );
  const storageObjectId = String(object.insertId);
  const [upload] = await connection.query<ResultSetHeader>(
    `INSERT INTO upload_sessions
      (public_id,family_id,created_by_member_id,original_filename,declared_size,
       committed_offset,state,computed_sha256,finalize_started_at,storage_object_id,
       completed_at,expires_at)
     VALUES (?,?,?,'旅行照片.jpg',?,?,'COMPLETE',?,CURRENT_TIMESTAMP(3),?,
       CURRENT_TIMESTAMP(3),DATE_ADD(CURRENT_TIMESTAMP(3),INTERVAL 1 DAY))`,
    [publicId, familyId, memberId, byteSize, byteSize, sha, storageObjectId],
  );
  const sourceUploadId = String(upload.insertId);
  const [media] = await connection.query<ResultSetHeader>(
    `INSERT INTO media_items
      (family_id,storage_object_id,source_upload_id,uploaded_at,timeline_key,
       detected_mime,processing_state,generation,metadata_generation)
     VALUES (?,?,?,CURRENT_TIMESTAMP(3),CURRENT_TIMESTAMP(3),'image/jpeg','READY',1,1)`,
    [familyId, storageObjectId, sourceUploadId],
  );
  return {
    storageObjectId,
    sourceUploadId,
    mediaId: String(media.insertId),
  };
}

function fileSnapshot(path: string) {
  const stat = lstatSync(path);
  return {
    bytes: readFileSync(path),
    inode: stat.ino,
    device: stat.dev,
    mode: stat.mode,
    nlink: stat.nlink,
    size: stat.size,
    mtimeMs: stat.mtimeMs,
  };
}
