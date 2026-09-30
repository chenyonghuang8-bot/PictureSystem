import { createHash, randomBytes, randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";

import type {
  PoolConnection,
  ResultSetHeader,
  RowDataPacket,
} from "mysql2/promise";
import type { FastifyReply, FastifyRequest } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AlbumRepositoryError as ApiAlbumRepositoryError } from "../../packages/db/dist/index.js";

import { createApp } from "../../apps/api/src/app.js";
import type { AlbumService } from "../../apps/api/src/albums/service.js";
import type {
  AuthContext,
  AuthService,
} from "../../apps/api/src/auth/service.js";
import { OriginalDownloadLimiter } from "../../apps/api/src/original-download/limiter.js";
import {
  OriginalDownloadService,
  type OriginalDownloadReader,
} from "../../apps/api/src/original-download/service.js";
import { PreviewDownloadLimiter } from "../../apps/api/src/preview-download/limiter.js";
import {
  PreviewDownloadService,
  type PreviewDownloadReader,
} from "../../apps/api/src/preview-download/service.js";
import {
  acquireCheckedConnection,
  AlbumRepositoryError,
  assertMigrationReadiness,
  createDatabase,
  MySqlAlbumRepository,
} from "../../packages/db/src/index.js";
import { albumRaceBarrier } from "../../packages/db/src/album-race-barrier-test-helper.js";
import type { AlbumRepositoryTestEvent } from "../../packages/db/src/album-repository-test-hooks.js";
import {
  CapacityGate,
  OriginalReader,
  StorageRoot,
} from "../../packages/storage/src/index.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("PHASE6D4_DEV_DATABASE_URL_REQUIRED");

type Identity = {
  userId: string;
  memberId: string;
  sessionId: string;
  tokenHash: Buffer;
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => (resolve = done));
  return { promise, resolve };
}

function controlledReader(payload: Buffer) {
  const entered = deferred<void>();
  const released = deferred<void>();
  const ledger = { entered: 0, settled: 0 };
  const reader: PreviewDownloadReader = {
    async read(_identity, { signal }) {
      ledger.entered += 1;
      entered.resolve();
      await released.promise;
      ledger.settled += 1;
      signal.throwIfAborted();
      return payload;
    },
  };
  return {
    reader,
    ledger,
    entered: entered.promise,
    release: () => released.resolve(),
  };
}

function countedPreviewReader(payload: Buffer, expectedEntries: number) {
  const allEntered = deferred<void>();
  const released = deferred<void>();
  let entered = 0;
  const reader: PreviewDownloadReader = {
    async read(_identity, { signal }) {
      entered += 1;
      if (entered === expectedEntries) allEntered.resolve();
      await released.promise;
      signal.throwIfAborted();
      return payload;
    },
  };
  return {
    reader,
    allEntered: allEntered.promise,
    release: () => released.resolve(),
  };
}

function countedOriginalReader(payload: Buffer) {
  const entered = deferred<void>();
  const released = deferred<void>();
  const reader: OriginalDownloadReader = {
    async withVerifiedDownload(_identity, { signal }, callback) {
      entered.resolve();
      await released.promise;
      signal.throwIfAborted();
      let sent = false;
      return await callback({
        async readNext() {
          if (sent) return { done: true } as const;
          sent = true;
          return { done: false, bytes: payload, final: true } as const;
        },
        async cancel() {},
      });
    },
  };
  return {
    reader,
    entered: entered.promise,
    release: () => released.resolve(),
  };
}

function heldSuccessfulExchange() {
  const sendEntered = deferred<void>();
  const sendReleased = deferred<void>();
  const requestRaw = Object.assign(new EventEmitter(), {
    aborted: false,
    destroyed: false,
  });
  const socket = Object.assign(new EventEmitter(), { destroyed: false });
  const response = Object.assign(new EventEmitter(), {
    destroyed: false,
    writable: true,
    writableEnded: false,
    writableFinished: false,
    socket,
    writeHead() {},
    destroy() {},
    write(_bytes: Buffer, callback: (error?: Error) => void) {
      sendEntered.resolve();
      void sendReleased.promise.then(() => {
        callback();
        response.emit("drain");
      });
      return false;
    },
    end() {
      response.writableEnded = true;
      response.writableFinished = true;
      response.emit("finish");
    },
  });
  return {
    request: { raw: requestRaw } as unknown as FastifyRequest,
    reply: { raw: response, hijack() {} } as unknown as FastifyReply,
    sendEntered: sendEntered.promise,
    releaseSend: () => sendReleased.resolve(),
  };
}

class ObservedLimiter extends PreviewDownloadLimiter {
  constructor(private readonly events: string[] = []) {
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

describe.sequential("Phase 6D4 private preview download", () => {
  const database = createDatabase(databaseUrl);
  const repository = new MySqlAlbumRepository(database.pool);
  const suffix = randomUUID().replaceAll("-", "");
  const fixtureBase = mkdtempSync(join(realpathSync(tmpdir()), "phase6d4-"));
  const mediaRoot = join(fixtureBase, "media");
  const root = StorageRoot.open(mediaRoot, { initialize: true });
  const previewBytes = Buffer.from(
    "UklGRiIAAABXRUJQVlA4IBYAAAAwAQCdASoBAAEAAUAmJaQAA3AA/vuUAAA=",
    "base64",
  );
  const previewSha = createHash("sha256").update(previewBytes).digest("hex");
  const originalBytes = Buffer.from(`phase-6d4-original-${suffix}`);
  const originalSha = createHash("sha256").update(originalBytes).digest("hex");
  const uploadPublicId = randomBytes(16);
  const uploadId = uploadPublicId.toString("hex");
  let gate: CapacityGate;
  let familyId = "";
  let otherFamilyId = "";
  let owner = emptyIdentity();
  let viewer = emptyIdentity();
  let superAdmin = emptyIdentity();
  let outsider = emptyIdentity();
  let albumId = "";
  let familyAlbumId = "";
  let hiddenAlbumId = "";
  let storageObjectId = "";
  let mediaId = "";
  let jobId = "";
  let derivedAssetId = "";
  let originalPath = "";
  let previewPath = "";

  beforeAll(async () => {
    const connection = await database.pool.getConnection();
    try {
      await preflight(connection);
      familyId = await insertFamily(connection, `Phase 6D4 ${suffix}`);
      otherFamilyId = await insertFamily(
        connection,
        `Phase 6D4 other ${suffix}`,
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
        "CUSTOM",
      );
      familyAlbumId = await insertAlbum(
        connection,
        familyId,
        owner.memberId,
        "FAMILY",
      );
      hiddenAlbumId = await insertAlbum(
        connection,
        familyId,
        owner.memberId,
        "CUSTOM",
      );
      await putView(connection, familyId, albumId, viewer.memberId, true);

      root.createUploadPayload(familyId, uploadId, originalBytes);
      const published = root.publishOriginal({
        familyId,
        uploadId,
        sha256Hex: originalSha,
        byteSize: String(originalBytes.length),
      });
      originalPath = join(mediaRoot, published.relativePath);
      const inserted = await insertMedia(
        connection,
        familyId,
        owner.memberId,
        uploadPublicId,
        Buffer.from(originalSha, "hex"),
        originalBytes.length,
      );
      storageObjectId = inserted.storageObjectId;
      mediaId = inserted.mediaId;
      jobId = inserted.jobId;
      await connection.query(
        "INSERT INTO album_media (family_id,album_id,media_id) VALUES (?,?,?),(?,?,?)",
        [familyId, albumId, mediaId, familyId, familyAlbumId, mediaId],
      );
      const [asset] = await connection.query<ResultSetHeader>(
        `INSERT INTO derived_assets
          (family_id,media_id,generation,recipe_id,kind,state,reserved_bytes,
           byte_size,sha256,width,height,output_mime,producer_job_id,
           producer_lease_epoch,published_at)
         VALUES (?,?,1,1,'PREVIEW','READY',4194304,?,?,1,1,'image/webp',?,1,
                 CURRENT_TIMESTAMP(3))`,
        [
          familyId,
          mediaId,
          previewBytes.length,
          Buffer.from(previewSha, "hex"),
          jobId,
        ],
      );
      derivedAssetId = String(asset.insertId);
      previewPath = placePreview(mediaRoot, familyId, mediaId, previewBytes);
      root.provisionSharedCapacityLockForDev();
      gate = CapacityGate.open({
        mediaRoot: root.canonicalPath,
        expectedMarkerId: root.markerId,
      });
    } finally {
      connection.release();
    }
  });

  afterAll(async () => {
    for (const id of [familyId, otherFamilyId]) {
      const [users] = await database.pool.query<RowDataPacket[]>(
        "SELECT CAST(user_id AS CHAR) AS userId FROM family_members WHERE family_id=?",
        [id],
      );
      for (const table of [
        "album_media",
        "album_members",
        "derived_assets",
        "background_jobs",
        "media_items",
        "upload_sessions",
        "storage_objects",
        "albums",
      ]) {
        await database.pool.query(`DELETE FROM ${table} WHERE family_id=?`, [
          id,
        ]);
      }
      for (const user of users) {
        await database.pool.query("DELETE FROM sessions WHERE user_id=?", [
          String(user.userId),
        ]);
      }
      await database.pool.query(
        "DELETE FROM family_members WHERE family_id=?",
        [id],
      );
      for (const user of users) {
        await database.pool.query("DELETE FROM users WHERE id=?", [
          String(user.userId),
        ]);
      }
      await database.pool.query("DELETE FROM families WHERE id=?", [id]);
    }
    const [residue] = await database.pool.query<RowDataPacket[]>(
      "SELECT COUNT(*) AS count FROM families WHERE id IN (?,?)",
      [familyId, otherFamilyId],
    );
    expect(String(residue[0]?.count)).toBe("0");
    await database.pool.end();
    gate?.close();
    root.close();
    expect(relative(realpathSync(tmpdir()), fixtureBase)).toMatch(
      /^phase6d4-/u,
    );
    rmSync(fixtureBase, { recursive: true, force: true });
  });

  it("serves exact bytes through the real derived reader and preserves canonical state", async () => {
    const beforeOriginal = fileSnapshot(originalPath);
    const beforePreview = fileSnapshot(previewPath);
    const beforeRows = await canonicalSnapshot();
    const server = createServer(viewer, repository, realReader());
    const response = await server.inject({
      method: "GET",
      url: `/api/v1/albums/${albumId}/media/${mediaId}/download/preview`,
      headers: {
        cookie: "__Host-family_session=synthetic",
        range: "bytes=0-3",
      },
    });
    expect(response.statusCode).toBe(200);
    expect(response.rawPayload).toEqual(previewBytes);
    expect(response.headers["content-type"]).toBe("image/webp");
    expect(response.headers["accept-ranges"]).toBe("none");
    expect(response.headers["content-range"]).toBeUndefined();
    expect(fileSnapshot(originalPath)).toEqual(beforeOriginal);
    expect(fileSnapshot(previewPath)).toEqual(beforePreview);
    expect(await canonicalSnapshot()).toEqual(beforeRows);
    await server.close();
  });

  it("enforces the selected-album security and freshness matrix", async () => {
    await expect(prepare(owner, albumId)).resolves.toMatchObject({ mediaId });
    await expect(prepare(viewer, familyAlbumId)).resolves.toMatchObject({
      mediaId,
    });
    await expect(prepare(viewer, albumId)).resolves.toMatchObject({ mediaId });
    await expect(prepare(superAdmin, hiddenAlbumId)).rejects.toMatchObject({
      reason: "NOT_FOUND",
    });
    await expect(prepare(outsider, albumId)).rejects.toMatchObject({
      reason: "NOT_FOUND",
    });
    await expect(prepare(viewer, hiddenAlbumId)).rejects.toMatchObject({
      reason: "NOT_FOUND",
    });

    for (const mutation of [
      {
        apply:
          "UPDATE media_items SET processing_state='BLOCKED',last_failure_code='MALFORMED_MEDIA' WHERE id=?",
        restore:
          "UPDATE media_items SET processing_state='READY',last_failure_code=NULL WHERE id=?",
      },
      {
        apply:
          "UPDATE media_items SET processing_state='PARTIAL',generation=2 WHERE id=?",
        restore:
          "UPDATE media_items SET processing_state='READY',generation=1 WHERE id=?",
      },
      {
        apply: "UPDATE media_items SET recipe_id=2 WHERE id=?",
        restore: "UPDATE media_items SET recipe_id=1 WHERE id=?",
      },
      {
        apply:
          "UPDATE derived_assets SET state='FAILED',failure_code='UNSUPPORTED_FORMAT' WHERE id=?",
        restore:
          "UPDATE derived_assets SET state='READY',failure_code=NULL WHERE id=?",
      },
      {
        apply:
          "UPDATE derived_assets SET kind='THUMBNAIL',reserved_bytes=524288 WHERE id=?",
        restore:
          "UPDATE derived_assets SET kind='PREVIEW',reserved_bytes=4194304 WHERE id=?",
      },
      {
        apply: "UPDATE derived_assets SET generation=2 WHERE id=?",
        restore: "UPDATE derived_assets SET generation=1 WHERE id=?",
      },
      {
        apply: "UPDATE derived_assets SET recipe_id=2 WHERE id=?",
        restore: "UPDATE derived_assets SET recipe_id=1 WHERE id=?",
      },
      {
        apply:
          "UPDATE derived_assets SET state='FAILED',failure_code='UNSUPPORTED_FORMAT',cleaned_at=DATE_ADD(published_at,INTERVAL 1 SECOND) WHERE id=?",
        restore:
          "UPDATE derived_assets SET state='READY',failure_code=NULL,cleaned_at=NULL WHERE id=?",
      },
    ]) {
      await database.pool.query(mutation.apply, [
        mutation.apply.includes("media_items") ? mediaId : derivedAssetId,
      ]);
      await expect(prepare(viewer, albumId)).rejects.toMatchObject({
        reason: "NOT_FOUND",
      });
      await database.pool.query(mutation.restore, [
        mutation.restore.includes("media_items") ? mediaId : derivedAssetId,
      ]);
    }
  });

  it("fails closed when the configured recipe changes during the read", async () => {
    let configuredRecipe = 1;
    const changingRepository = new MySqlAlbumRepository(database.pool, {
      getConfiguredPreviewRecipeId: () => configuredRecipe,
    });
    const controlled = controlledReader(previewBytes);
    const limiter = new PreviewDownloadLimiter();
    const server = createServer(
      viewer,
      serviceRepository(changingRepository),
      controlled.reader,
      limiter,
    );
    const pending = server.inject({
      method: "GET",
      url: `/api/v1/albums/${albumId}/media/${mediaId}/download/preview`,
      headers: { cookie: "__Host-family_session=synthetic" },
    });
    await controlled.entered;
    configuredRecipe = 2;
    controlled.release();
    const response = await pending;
    expect(response.statusCode).toBe(404);
    expect(response.headers["content-disposition"]).toBeUndefined();
    expect(limiter.snapshot().active).toBe(0);
    await server.close();
  });

  it("fails closed on real derived storage identity and entry mismatches", async () => {
    await expect(
      readWithGate({ mediaId: `${Number(mediaId) + 90_000}`, byteSize: 1n }),
    ).rejects.toMatchObject({ reason: "DERIVED_SERVE_ABSENT" });
    await expect(
      readWithGate({ byteSize: BigInt(previewBytes.length + 1) }),
    ).rejects.toMatchObject({ reason: "DERIVED_SERVE_MISMATCH" });
    await expect(
      readWithGate({ sha256Hex: "b".repeat(64) }),
    ).rejects.toMatchObject({ reason: "DERIVED_SERVE_MISMATCH" });

    const oversizedMediaId = `${Number(mediaId) + 90_001}`;
    const oversized = Buffer.alloc(4_194_305, 1);
    placePreview(mediaRoot, familyId, oversizedMediaId, oversized);
    await expect(
      readWithGate({
        mediaId: oversizedMediaId,
        byteSize: BigInt(oversized.length),
        sha256Hex: createHash("sha256").update(oversized).digest("hex"),
      }),
    ).rejects.toMatchObject({ reason: "DERIVED_SERVE_MISMATCH" });

    const symlinkMediaId = `${Number(mediaId) + 90_002}`;
    const linkPath = preparePreviewParent(mediaRoot, familyId, symlinkMediaId);
    symlinkSync(previewPath, linkPath);
    await expect(
      readWithGate({ mediaId: symlinkMediaId }),
    ).rejects.toMatchObject({ reason: "DERIVED_SERVE_MISMATCH" });

    await expect(readWithGate({ recipeId: 2 as 1 })).rejects.toMatchObject({
      reason: "DERIVED_SERVE_IDENTITY",
    });
    expect(await canonicalSnapshot()).toMatchObject({
      mediaGeneration: "1",
      mediaRecipe: 1,
      processingState: "READY",
    });
  });

  it.each(stateFirstMutations())(
    "rejects committed $name changes at second authorization",
    async ({ mutate, restore }) => {
      const controlled = controlledReader(previewBytes);
      const limiter = new ObservedLimiter();
      let recheckReason: string | undefined;
      const wrapped = serviceRepository(repository, (error) => {
        recheckReason = error.reason;
      });
      const server = createServer(viewer, wrapped, controlled.reader, limiter);
      const pending = server.inject({
        method: "GET",
        url: `/api/v1/albums/${albumId}/media/${mediaId}/download/preview`,
        headers: { cookie: "__Host-family_session=synthetic" },
      });
      try {
        await controlled.entered;
        expect(limiter.snapshot().active).toBe(1);
        await committedFamilyMutation(database.pool, familyId, mutate);
        controlled.release();
        const response = await pending;
        expect([401, 404]).toContain(response.statusCode);
        expect(recheckReason).toMatch(/^(UNAUTHENTICATED|NOT_FOUND)$/u);
        expect(response.headers["content-disposition"]).toBeUndefined();
        expect(response.rawPayload.equals(previewBytes)).toBe(false);
        expect(controlled.ledger).toEqual({ entered: 1, settled: 1 });
        expect(limiter.snapshot().active).toBe(0);
      } finally {
        controlled.release();
        await pending.catch(() => undefined);
        await committedFamilyMutation(database.pool, familyId, restore);
        await server.close();
      }
    },
  );

  it.each([
    {
      name: "ACL",
      mutate: (connection: PoolConnection) =>
        putView(connection, familyId, albumId, viewer.memberId, false),
      restore: (connection: PoolConnection) =>
        putView(connection, familyId, albumId, viewer.memberId, true),
    },
    {
      name: "generation",
      mutate: (connection: PoolConnection) =>
        connection.query(
          "UPDATE media_items SET processing_state='PARTIAL',generation=2 WHERE id=?",
          [mediaId],
        ),
      restore: (connection: PoolConnection) =>
        connection.query(
          "UPDATE media_items SET processing_state='READY',generation=1 WHERE id=?",
          [mediaId],
        ),
    },
  ])(
    "linearizes before a waiting $name mutation",
    async ({ mutate, restore }) => {
      const validated = albumRaceBarrier(
        {
          stage: "PREVIEW_DOWNLOAD_VALIDATED_BEFORE_COMMIT",
          operation: "PREVIEW_DOWNLOAD_RECHECK",
        },
        { pause: true },
      );
      const controlled = controlledReader(previewBytes);
      const events: string[] = [];
      const winning = new MySqlAlbumRepository(database.pool, {
        testHook: validated.hook,
      });
      const server = createServer(
        viewer,
        serviceRepository(winning, undefined, () =>
          events.push("second-commit"),
        ),
        controlled.reader,
        new ObservedLimiter(events),
      );
      const pending = server.inject({
        method: "GET",
        url: `/api/v1/albums/${albumId}/media/${mediaId}/download/preview`,
        headers: { cookie: "__Host-family_session=synthetic" },
      });
      try {
        await controlled.entered;
        controlled.release();
        const event = await validated.wait();
        const secondId = requiredConnectionId(event);
        const dispatched = deferred<number>();
        const mutation = committedFamilyMutation(
          database.pool,
          familyId,
          mutate,
          (id) => dispatched.resolve(id),
          () => events.push("mutation-commit"),
          () => events.push("lock-wait"),
        );
        expect(await dispatched.promise).not.toBe(secondId);
        expect(events).toContain("lock-wait");
        validated.release();
        const response = await pending;
        await mutation;
        expect(response.statusCode).toBe(200);
        expect(response.rawPayload).toEqual(previewBytes);
        expect(events.indexOf("second-commit")).toBeLessThan(
          events.indexOf("mutation-commit"),
        );
        const next = await server.inject({
          method: "GET",
          url: `/api/v1/albums/${albumId}/media/${mediaId}/download/preview`,
          headers: { cookie: "__Host-family_session=synthetic" },
        });
        expect(next.statusCode).toBe(404);
      } finally {
        validated.release();
        controlled.release();
        await pending.catch(() => undefined);
        await committedFamilyMutation(database.pool, familyId, restore);
        await server.close();
      }
    },
  );

  it("runs actual Original and Preview services concurrently with independent settlement", async () => {
    const originalReader = countedOriginalReader(originalBytes);
    const previewReader = countedPreviewReader(previewBytes, 2);
    const originalLimiter = new OriginalDownloadLimiter();
    const previewLimiter = new PreviewDownloadLimiter();
    const originalService = new OriginalDownloadService(
      repository,
      originalReader.reader,
      originalLimiter,
    );
    const previewService = new PreviewDownloadService(
      repository,
      previewReader.reader,
      previewLimiter,
    );
    const originalExchange = heldSuccessfulExchange();
    const previewExchangeA = heldSuccessfulExchange();
    const previewExchangeB = heldSuccessfulExchange();
    const input = { albumId, mediaId };
    const auth = authContext(viewer);
    const originalPending = originalService.download(
      auth,
      input,
      originalExchange.request,
      originalExchange.reply,
    );
    const previewPendingA = previewService.download(
      input,
      previewExchangeA.request,
      previewExchangeA.reply,
      async () => auth,
    );
    const previewPendingB = previewService.download(
      input,
      previewExchangeB.request,
      previewExchangeB.reply,
      async () => auth,
    );
    try {
      await Promise.all([originalReader.entered, previewReader.allEntered]);
      expect(originalLimiter.snapshot()).toEqual({
        active: 1,
        activeMembers: 1,
      });
      expect(previewLimiter.snapshot()).toEqual({
        active: 2,
        activeMembers: 1,
        memberCounts: [2],
      });

      const rejectedOriginal = heldSuccessfulExchange();
      await expect(
        originalService.download(
          auth,
          input,
          rejectedOriginal.request,
          rejectedOriginal.reply,
        ),
      ).rejects.toMatchObject({ statusCode: 429, retryAfterSeconds: 1 });
      const rejectedPreview = heldSuccessfulExchange();
      await expect(
        previewService.download(
          input,
          rejectedPreview.request,
          rejectedPreview.reply,
          async () => auth,
        ),
      ).rejects.toMatchObject({ statusCode: 429, retryAfterSeconds: 1 });

      // Both prepare transactions have committed even though storage is held.
      await committedFamilyMutation(database.pool, familyId, async () => {});

      originalReader.release();
      previewReader.release();
      await Promise.all([
        originalExchange.sendEntered,
        previewExchangeA.sendEntered,
        previewExchangeB.sendEntered,
      ]);
      // Both second authorizations have committed while network sends remain held.
      await committedFamilyMutation(database.pool, familyId, async () => {});

      previewExchangeA.releaseSend();
      previewExchangeB.releaseSend();
      await Promise.all([previewPendingA, previewPendingB]);
      expect(originalLimiter.snapshot()).toEqual({
        active: 1,
        activeMembers: 1,
      });
      expect(previewLimiter.snapshot()).toEqual({
        active: 0,
        activeMembers: 0,
        memberCounts: [],
      });

      originalExchange.releaseSend();
      await originalPending;
      expect(originalLimiter.snapshot()).toEqual({
        active: 0,
        activeMembers: 0,
      });
    } finally {
      originalReader.release();
      previewReader.release();
      originalExchange.releaseSend();
      previewExchangeA.releaseSend();
      previewExchangeB.releaseSend();
      await Promise.allSettled([
        originalPending,
        previewPendingA,
        previewPendingB,
      ]);
    }
  });

  it("completes concurrent mixed downloads through both real storage readers", async () => {
    const nativeOriginalReader = OriginalReader.open({
      mediaRoot: root.canonicalPath,
      expectedMarkerId: root.markerId,
    });
    const server = createApp({
      authService: fixedAuth(viewer),
      albumService: {} as AlbumService,
      originalDownloadService: new OriginalDownloadService(
        repository,
        nativeOriginalReader,
      ),
      previewDownloadService: new PreviewDownloadService(
        repository,
        realReader(),
      ),
      trustedOrigins: new Set(["https://family.test"]),
    });
    try {
      const [original, preview] = await Promise.all([
        server.inject({
          method: "GET",
          url: `/api/v1/albums/${albumId}/media/${mediaId}/download/original`,
          headers: { cookie: "__Host-family_session=synthetic" },
        }),
        server.inject({
          method: "GET",
          url: `/api/v1/albums/${albumId}/media/${mediaId}/download/preview`,
          headers: { cookie: "__Host-family_session=synthetic" },
        }),
      ]);
      expect(original.statusCode).toBe(200);
      expect(original.rawPayload).toEqual(originalBytes);
      expect(preview.statusCode).toBe(200);
      expect(preview.rawPayload).toEqual(previewBytes);
    } finally {
      await server.close();
      nativeOriginalReader.close();
    }
  });

  function stateFirstMutations() {
    return [
      row(
        "ACL",
        (c) => putView(c, familyId, albumId, viewer.memberId, false),
        (c) => putView(c, familyId, albumId, viewer.memberId, true),
      ),
      row(
        "placement",
        (c) =>
          c.query(
            "DELETE FROM album_media WHERE family_id=? AND album_id=? AND media_id=?",
            [familyId, albumId, mediaId],
          ),
        (c) =>
          c.query(
            "INSERT INTO album_media (family_id,album_id,media_id) VALUES (?,?,?)",
            [familyId, albumId, mediaId],
          ),
      ),
      update(
        "member disable",
        "family_members",
        "disabled_at=CURRENT_TIMESTAMP(3)",
        "disabled_at=NULL",
        () => viewer.memberId,
      ),
      update(
        "member leave",
        "family_members",
        "left_at=CURRENT_TIMESTAMP(3)",
        "left_at=NULL",
        () => viewer.memberId,
      ),
      update(
        "session revoke",
        "sessions",
        "revoked_at=CURRENT_TIMESTAMP(3),revoke_reason='USER_REVOKE'",
        "revoked_at=NULL,revoke_reason=NULL",
        () => viewer.sessionId,
      ),
      update(
        "user disable",
        "users",
        "disabled_at=CURRENT_TIMESTAMP(3)",
        "disabled_at=NULL",
        () => viewer.userId,
      ),
      update(
        "storage",
        "storage_objects",
        "state='MISSING'",
        "state='AVAILABLE'",
        () => storageObjectId,
      ),
      update(
        "media blocked",
        "media_items",
        "processing_state='BLOCKED',last_failure_code='MALFORMED_MEDIA'",
        "processing_state='READY',last_failure_code=NULL",
        () => mediaId,
      ),
      update(
        "generation",
        "media_items",
        "processing_state='PARTIAL',generation=2",
        "processing_state='READY',generation=1",
        () => mediaId,
      ),
      update(
        "READY invalidation",
        "derived_assets",
        "state='FAILED',failure_code='UNSUPPORTED_FORMAT'",
        "state='READY',failure_code=NULL",
        () => derivedAssetId,
      ),
      update(
        "derived identity",
        "derived_assets",
        `sha256=UNHEX('${"b".repeat(64)}')`,
        `sha256=UNHEX('${previewSha}')`,
        () => derivedAssetId,
      ),
      update(
        "derived size",
        "derived_assets",
        "byte_size=byte_size+1",
        `byte_size=${previewBytes.length}`,
        () => derivedAssetId,
      ),
      update(
        "recipe",
        "media_items",
        "recipe_id=2",
        "recipe_id=1",
        () => mediaId,
      ),
    ];
  }

  function update(
    name: string,
    table: string,
    change: string,
    restore: string,
    id: () => string,
  ) {
    return row(
      name,
      (connection) =>
        connection.query(`UPDATE ${table} SET ${change} WHERE id=?`, [id()]),
      (connection) =>
        connection.query(`UPDATE ${table} SET ${restore} WHERE id=?`, [id()]),
    );
  }

  function row(
    name: string,
    mutate: (connection: PoolConnection) => Promise<unknown>,
    restore: (connection: PoolConnection) => Promise<unknown>,
  ) {
    return { name, mutate, restore };
  }

  function prepare(identity: Identity, selectedAlbumId: string) {
    return repository.preparePreviewDownload({
      actor: actor(identity),
      albumId: selectedAlbumId,
      mediaId,
    });
  }

  function realReader(): PreviewDownloadReader {
    return {
      async read(identity, { signal }) {
        return gate.withLock(() => {
          signal.throwIfAborted();
          return Promise.resolve(gate.readDerivedFinal(identity));
        });
      },
    };
  }

  function readWithGate(
    overrides: Partial<{
      mediaId: string;
      generation: bigint;
      recipeId: 1;
      sha256Hex: string;
      byteSize: bigint;
    }>,
  ) {
    return gate.withLock(() =>
      Promise.resolve(
        gate.readDerivedFinal({
          familyId,
          mediaId,
          generation: 1n,
          recipeId: 1,
          kind: "PREVIEW",
          sha256Hex: previewSha,
          byteSize: BigInt(previewBytes.length),
          ...overrides,
        }),
      ),
    );
  }

  function createServer(
    identity: Identity,
    source: Parameters<typeof serviceRepository>[0] | MySqlAlbumRepository,
    reader: PreviewDownloadReader,
    limiter = new PreviewDownloadLimiter(),
  ) {
    return createApp({
      authService: fixedAuth(identity),
      albumService: {} as AlbumService,
      previewDownloadService: new PreviewDownloadService(
        source as never,
        reader,
        limiter,
      ),
      trustedOrigins: new Set(["https://family.test"]),
    });
  }

  async function canonicalSnapshot() {
    const connection = await acquireCheckedConnection(database.pool);
    try {
      const [rows] = await connection.query<RowDataPacket[]>(
        `SELECT
        (SELECT LOWER(HEX(sha256)) FROM storage_objects WHERE id=?) storageSha,
        (SELECT state FROM storage_objects WHERE id=?) storageState,
        (SELECT CAST(source_upload_id AS CHAR) FROM media_items WHERE id=?) sourceUploadId,
        (SELECT CAST(generation AS CHAR) FROM media_items WHERE id=?) mediaGeneration,
        (SELECT recipe_id FROM media_items WHERE id=?) mediaRecipe,
        (SELECT processing_state FROM media_items WHERE id=?) processingState,
        (SELECT CONCAT(id,':',family_id,':',album_id,':',media_id) FROM album_media WHERE family_id=? AND album_id=? AND media_id=?) placement,
        (SELECT CONCAT_WS(':',id,generation,recipe_id,kind,state,reserved_bytes,byte_size,LOWER(HEX(sha256)),producer_job_id,producer_lease_epoch,UNIX_TIMESTAMP(published_at),COALESCE(UNIX_TIMESTAMP(cleaned_at),'NULL')) FROM derived_assets WHERE id=?) derivedIdentity,
        (SELECT CONCAT_WS(':',id,generation,recipe_id,job_type,state,COALESCE(lease_epoch,'NULL')) FROM background_jobs WHERE id=?) jobIdentity`,
        [
          storageObjectId,
          storageObjectId,
          mediaId,
          mediaId,
          mediaId,
          mediaId,
          familyId,
          albumId,
          mediaId,
          derivedAssetId,
          jobId,
        ],
      );
      return rows[0];
    } finally {
      connection.release();
    }
  }
});

function serviceRepository(
  source: MySqlAlbumRepository,
  onRecheckError?: (error: AlbumRepositoryError) => void,
  onRecheckSuccess?: () => void,
) {
  return {
    preparePreviewDownload: async (
      ...args: Parameters<MySqlAlbumRepository["preparePreviewDownload"]>
    ) => {
      try {
        return await source.preparePreviewDownload(...args);
      } catch (error) {
        if (error instanceof AlbumRepositoryError) {
          throw new ApiAlbumRepositoryError(error.reason);
        }
        throw error;
      }
    },
    recheckPreviewDownload: async (
      ...args: Parameters<MySqlAlbumRepository["recheckPreviewDownload"]>
    ) => {
      try {
        const result = await source.recheckPreviewDownload(...args);
        onRecheckSuccess?.();
        return result;
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

async function committedFamilyMutation(
  pool: ReturnType<typeof createDatabase>["pool"],
  familyId: string,
  mutate: (connection: PoolConnection) => Promise<unknown>,
  onDispatched?: (connectionId: number) => void,
  onCommitted?: () => void,
  onLockWait?: (connectionId: number) => void,
) {
  const connection = await pool.getConnection();
  let started = false;
  try {
    const connectionId = await mysqlConnectionId(connection);
    await connection.beginTransaction();
    started = true;
    if (onLockWait) {
      const [rows] = await connection.query<RowDataPacket[]>(
        "SELECT @@SESSION.innodb_lock_wait_timeout AS value",
      );
      const previous = Number(rows[0]?.value);
      await connection.query("SET SESSION innodb_lock_wait_timeout=1");
      try {
        await connection.query(
          "SELECT id FROM families WHERE id=? FOR UPDATE",
          [familyId],
        );
        throw new Error("MYSQL_LOCK_WAIT_EXPECTED");
      } catch (error) {
        if (!isLockWait(error)) throw error;
        onLockWait(connectionId);
      } finally {
        await connection.query("SET SESSION innodb_lock_wait_timeout=?", [
          previous,
        ]);
      }
    }
    const lock = connection.query(
      "SELECT id FROM families WHERE id=? FOR UPDATE",
      [familyId],
    );
    void lock.catch(() => undefined);
    onDispatched?.(connectionId);
    await lock;
    await mutate(connection);
    await connection.commit();
    started = false;
    onCommitted?.();
  } catch (error) {
    if (started) await connection.rollback().catch(() => undefined);
    throw error;
  } finally {
    connection.release();
  }
}

function requiredConnectionId(event: AlbumRepositoryTestEvent) {
  const value = Number(event.connectionId);
  if (!Number.isSafeInteger(value) || value <= 0)
    throw new Error("CONNECTION_ID_MISSING");
  return value;
}

async function mysqlConnectionId(connection: PoolConnection) {
  const [rows] = await connection.query<RowDataPacket[]>(
    "SELECT CONNECTION_ID() AS value",
  );
  return Number(rows[0]?.value);
}

function isLockWait(error: unknown) {
  const candidate = error as { code?: string; errno?: number };
  return candidate?.code === "ER_LOCK_WAIT_TIMEOUT" && candidate.errno === 1205;
}

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

function authContext(identity: Identity): AuthContext {
  return {
    identity: { userId: identity.userId, sessionId: identity.sessionId },
    tokenHash: identity.tokenHash,
  } as unknown as AuthContext;
}

function fixedAuth(identity: Identity) {
  return {
    authenticate: async () => authContext(identity),
  } as unknown as AuthService;
}

async function preflight(connection: PoolConnection) {
  const [rows] = await connection.query<RowDataPacket[]>(
    `SELECT DATABASE() db, VERSION() version, CURRENT_USER() account,
            @@GLOBAL.innodb_native_foreign_keys nativeFk,
            @@SESSION.foreign_key_checks foreignKeyChecks`,
  );
  const row = rows[0];
  if (
    row?.db !== "family_album_dev" ||
    !String(row.version).startsWith("9.7.2") ||
    String(row.account).split("@")[0]?.toLowerCase() === "root" ||
    String(row.nativeFk) !== "1" ||
    String(row.foreignKeyChecks) !== "1"
  ) {
    throw new Error("PHASE6D4_DEV_PREFLIGHT_FAILED");
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
  const username = `p6d4_${label}_${suffix}`;
  const [user] = await connection.query<ResultSetHeader>(
    `INSERT INTO users
      (username,username_normalized,password_hash,display_name,password_changed_at)
     VALUES (?,?,?,?,CURRENT_TIMESTAMP(3))`,
    [username, Buffer.from(username), "synthetic-not-used", `P6D4 ${label}`],
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
  visibility: "CUSTOM" | "FAMILY",
) {
  const [row] = await connection.query<ResultSetHeader>(
    "INSERT INTO albums (family_id,owner_member_id,name,visibility) VALUES (?,?,?,?)",
    [familyId, ownerMemberId, `P6D4 ${visibility}`, visibility],
  );
  return String(row.insertId);
}

async function putView(
  connection: Pick<PoolConnection, "query">,
  familyId: string,
  albumId: string,
  memberId: string,
  enabled: boolean,
) {
  await connection.query(
    `INSERT INTO album_members (family_id,album_id,member_id,can_view)
     VALUES (?,?,?,?) AS new ON DUPLICATE KEY UPDATE can_view=new.can_view`,
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
     VALUES (?,?,?,'synthetic.webp',?,?,'COMPLETE',?,CURRENT_TIMESTAMP(3),?,
             CURRENT_TIMESTAMP(3),DATE_ADD(CURRENT_TIMESTAMP(3),INTERVAL 1 DAY))`,
    [publicId, familyId, memberId, byteSize, byteSize, sha, storageObjectId],
  );
  const sourceUploadId = String(upload.insertId);
  const [media] = await connection.query<ResultSetHeader>(
    `INSERT INTO media_items
      (family_id,storage_object_id,source_upload_id,uploaded_at,timeline_key,
       detected_mime,processing_state,generation,recipe_id,metadata_generation)
     VALUES (?,?,?,CURRENT_TIMESTAMP(3),CURRENT_TIMESTAMP(3),'image/webp','READY',1,1,1)`,
    [familyId, storageObjectId, sourceUploadId],
  );
  const mediaId = String(media.insertId);
  const [job] = await connection.query<ResultSetHeader>(
    `INSERT INTO background_jobs
      (family_id,media_id,generation,recipe_id,job_type,state,available_at)
     VALUES (?,?,1,1,'IMAGE_DERIVATIVES','QUEUED',CURRENT_TIMESTAMP(3))`,
    [familyId, mediaId],
  );
  return {
    storageObjectId,
    sourceUploadId,
    mediaId,
    jobId: String(job.insertId),
  };
}

function placePreview(
  rootPath: string,
  familyId: string,
  mediaId: string,
  bytes: Buffer,
) {
  const path = preparePreviewParent(rootPath, familyId, mediaId);
  writeFileSync(path, bytes, { mode: 0o600 });
  chmodSync(path, 0o400);
  return path;
}

function preparePreviewParent(
  rootPath: string,
  familyId: string,
  mediaId: string,
) {
  const directory = join(rootPath, "derived", familyId, mediaId, "r1", "g1");
  mkdirSync(directory, { recursive: true });
  let current = join(rootPath, "derived");
  for (const segment of [familyId, mediaId, "r1", "g1"]) {
    chmodSync(current, 0o700);
    current = join(current, segment);
  }
  chmodSync(directory, 0o700);
  return join(directory, "preview.webp");
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
