import { createHash, randomBytes, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  closeSync,
  copyFileSync,
  createReadStream,
  chmodSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  writeSync,
  writeFileSync,
} from "node:fs";
import {
  Agent,
  request as httpsRequest,
  type IncomingHttpHeaders,
} from "node:https";
import { resolve } from "node:path";

import { expect, test } from "@playwright/test";
import type {
  PoolConnection,
  ResultSetHeader,
  RowDataPacket,
} from "mysql2/promise";

import {
  hashPassword,
  normalizeUsername,
} from "../../packages/auth/src/index.js";
import {
  assertMigrationReadiness,
  createDatabase,
  MySqlAlbumRepository,
} from "../../packages/db/src/index.js";
import {
  buildOriginalPath,
  buildUploadPayloadPath,
  CapacityGate,
} from "../../packages/storage/src/index.js";
import {
  assertSensitiveCategoryAbsent,
  assertSensitiveValuesEqual,
  parseSessionCookie,
} from "../helpers/security-assertions.js";

const rootDir = resolve(import.meta.dirname, "../..");
process.loadEnvFile(resolve(rootDir, ".env"));
const databaseUrl = process.env.DATABASE_URL;
const mediaRoot = process.env.PHASE5_WEB_E2E_MEDIA_ROOT;
const markerId = process.env.PHASE5_WEB_E2E_MARKER_ID;
const apiObservationLog = process.env.PHASE6D5_API_OBSERVATION_LOG;
if (!databaseUrl || !mediaRoot || !markerId || !apiObservationLog) {
  throw new Error("PHASE6D5_HTTPS_ENVIRONMENT_REQUIRED");
}

const database = createDatabase(databaseUrl);
const tlsAgent = new Agent({ rejectUnauthorized: false, keepAlive: false });
const suffix = randomUUID().replaceAll("-", "").slice(0, 20);
const username = `p6d5_https_${suffix}`;
const password = "phase6d5-synthetic-password";
const largeBytes = 67_108_864;
const chunkBytes = 256 * 1024;
const previewBytes = Buffer.alloc(4 * 1024 * 1024, 0x57);
const previewSha = createHash("sha256").update(previewBytes).digest("hex");
const hostileFilename = `../quote" slash/back\\percent%apostrophe'asterisk*家庭😀-${"长".repeat(80)}.jpeg`;

let familyId = "";
let userId = "";
let memberId = "";
let albumId = "";
let largeMediaId = "";
let smallMediaId = "";
let largeOriginalPath = "";
let previewPath = "";
let largeSha = "";
let cookie = "";
let beforeCanonical = "";
let beforeOriginal: FileIdentity;
let beforePreview: FileIdentity;
let familyAlbumId = "";
let hiddenAlbumId = "";
let emptyAlbumId = "";
let otherFamilyId = "";
let ownerActor = emptyLoginActor();
let familyActor = emptyLoginActor();
let explicitActor = emptyLoginActor();
let superAdminActor = emptyLoginActor();
let outsiderActor = emptyLoginActor();
const actorUserIds: string[] = [];

type LoginActor = {
  userId: string;
  memberId: string;
  username: string;
  password: string;
};

type FileIdentity = {
  sha256: string;
  device: number;
  inode: number;
  mode: number;
  nlink: number;
  size: number;
  mtimeMs: number;
};

test.describe.serial("Phase 6D5 real HTTPS download validation", () => {
  test.beforeAll(async () => {
    const connection = await database.pool.getConnection();
    try {
      await assertDevDatabase(connection);
      await assertMigrationReadiness(connection);
      const passwordHash = await hashPassword(password);
      const [family] = await connection.query<ResultSetHeader>(
        "INSERT INTO families (name) VALUES (?)",
        [`Phase 6D5 HTTPS ${suffix}`],
      );
      familyId = String(family.insertId);
      const [user] = await connection.query<ResultSetHeader>(
        `INSERT INTO users
          (username,username_normalized,password_hash,display_name,password_changed_at)
         VALUES (?,?,?,?,CURRENT_TIMESTAMP(3))`,
        [
          username,
          normalizeUsername(username).normalizedBytes,
          passwordHash,
          "Phase 6D5 synthetic",
        ],
      );
      userId = String(user.insertId);
      const [member] = await connection.query<ResultSetHeader>(
        "INSERT INTO family_members (family_id,user_id,role) VALUES (?,?,'ADMIN')",
        [familyId, userId],
      );
      memberId = String(member.insertId);
      ownerActor = { userId, memberId, username, password };
      actorUserIds.push(userId);
      familyActor = await insertLoginIdentity(
        connection,
        familyId,
        "family",
        "MEMBER",
        passwordHash,
      );
      explicitActor = await insertLoginIdentity(
        connection,
        familyId,
        "explicit",
        "MEMBER",
        passwordHash,
      );
      superAdminActor = await insertLoginIdentity(
        connection,
        familyId,
        "super_admin",
        "SUPER_ADMIN",
        passwordHash,
      );
      const [otherFamily] = await connection.query<ResultSetHeader>(
        "INSERT INTO families (name) VALUES (?)",
        [`Phase 6D5 HTTPS other ${suffix}`],
      );
      otherFamilyId = String(otherFamily.insertId);
      outsiderActor = await insertLoginIdentity(
        connection,
        otherFamilyId,
        "outsider",
        "MEMBER",
        passwordHash,
      );
      actorUserIds.push(
        familyActor.userId,
        explicitActor.userId,
        superAdminActor.userId,
        outsiderActor.userId,
      );
      const [album] = await connection.query<ResultSetHeader>(
        "INSERT INTO albums (family_id,owner_member_id,name,visibility) VALUES (?,?,?,'CUSTOM')",
        [familyId, memberId, `Phase 6D5 ${suffix}`],
      );
      albumId = String(album.insertId);
      familyAlbumId = await insertAlbum(
        connection,
        familyId,
        memberId,
        `Phase 6D5 FAMILY ${suffix}`,
        "FAMILY",
      );
      hiddenAlbumId = await insertAlbum(
        connection,
        familyId,
        memberId,
        `Phase 6D5 hidden ${suffix}`,
        "CUSTOM",
      );
      emptyAlbumId = await insertAlbum(
        connection,
        familyId,
        memberId,
        `Phase 6D5 empty ${suffix}`,
        "CUSTOM",
      );
      await connection.query(
        `INSERT INTO album_members (family_id,album_id,member_id,can_view)
         VALUES (?,?,?,1),(?,?,?,1)`,
        [
          familyId,
          albumId,
          explicitActor.memberId,
          familyId,
          emptyAlbumId,
          explicitActor.memberId,
        ],
      );

      const large = await createLargeOriginal(connection);
      largeMediaId = large.mediaId;
      largeOriginalPath = large.path;
      largeSha = large.sha256;
      const small = await createSmallOriginal(connection);
      smallMediaId = small.mediaId;
      await connection.query(
        `INSERT INTO album_media (family_id,album_id,media_id)
         VALUES (?,?,?),(?,?,?),(?,?,?),(?,?,?)`,
        [
          familyId,
          albumId,
          largeMediaId,
          familyId,
          albumId,
          smallMediaId,
          familyId,
          familyAlbumId,
          smallMediaId,
          familyId,
          hiddenAlbumId,
          smallMediaId,
        ],
      );
      previewPath = await createPreview(connection, largeMediaId);
      await createPreview(connection, smallMediaId);
      beforeCanonical = await canonicalSnapshot(connection);
      beforeOriginal = await fileIdentity(largeOriginalPath);
      beforePreview = await fileIdentity(previewPath);
    } finally {
      connection.release();
    }
  }, 120_000);

  test.afterAll(async () => {
    const connection = await database.pool.getConnection();
    try {
      for (const cleanupFamilyId of [familyId, otherFamilyId].filter(Boolean)) {
        for (const table of [
          "share_events",
          "shares",
          "album_media",
          "album_members",
          "derived_assets",
          "background_jobs",
          "media_items",
          "upload_sessions",
          "storage_objects",
          "albums",
        ]) {
          await connection.query(`DELETE FROM ${table} WHERE family_id=?`, [
            cleanupFamilyId,
          ]);
        }
        await connection.query("DELETE FROM family_members WHERE family_id=?", [
          cleanupFamilyId,
        ]);
        await connection.query("DELETE FROM families WHERE id=?", [
          cleanupFamilyId,
        ]);
      }
      for (const cleanupUserId of actorUserIds) {
        await connection.query("DELETE FROM sessions WHERE user_id=?", [
          cleanupUserId,
        ]);
        await connection.query("DELETE FROM users WHERE id=?", [cleanupUserId]);
      }
      if (familyId) {
        const familyPlaceholders = [familyId, otherFamilyId]
          .map(() => "?")
          .join(",");
        const userPlaceholders = actorUserIds.map(() => "?").join(",");
        const [rows] = await connection.query<RowDataPacket[]>(
          `SELECT
             (SELECT COUNT(*) FROM families WHERE id IN (${familyPlaceholders})) families,
             (SELECT COUNT(*) FROM users WHERE id IN (${userPlaceholders})) users,
             (SELECT COUNT(*) FROM sessions WHERE user_id IN (${userPlaceholders})) sessions,
             (SELECT COUNT(*) FROM shares WHERE family_id IN (${familyPlaceholders})) shares,
             (SELECT COUNT(*) FROM background_jobs WHERE family_id IN (${familyPlaceholders})) jobs,
             (SELECT COUNT(*) FROM derived_assets WHERE family_id IN (${familyPlaceholders})) derived,
             (SELECT COUNT(*) FROM album_media WHERE family_id IN (${familyPlaceholders})) placements,
             (SELECT COUNT(*) FROM media_items WHERE family_id IN (${familyPlaceholders})) media,
             (SELECT COUNT(*) FROM upload_sessions WHERE family_id IN (${familyPlaceholders})) uploads,
             (SELECT COUNT(*) FROM storage_objects WHERE family_id IN (${familyPlaceholders})) storage,
             (SELECT COUNT(*) FROM albums WHERE family_id IN (${familyPlaceholders})) albums,
             (SELECT COUNT(*) FROM family_members WHERE family_id IN (${familyPlaceholders})) members`,
          [
            familyId,
            otherFamilyId,
            ...actorUserIds,
            ...actorUserIds,
            familyId,
            otherFamilyId,
            familyId,
            otherFamilyId,
            familyId,
            otherFamilyId,
            familyId,
            otherFamilyId,
            familyId,
            otherFamilyId,
            familyId,
            otherFamilyId,
            familyId,
            otherFamilyId,
            familyId,
            otherFamilyId,
            familyId,
            otherFamilyId,
            familyId,
            otherFamilyId,
          ],
        );
        expect(Object.values(rows[0] ?? {}).map(String)).toEqual(
          Array(12).fill("0"),
        );
      }
    } finally {
      connection.release();
      tlsAgent.destroy();
      await database.pool.end();
    }
  });

  test("uses real Secure-cookie login and blocks HEAD metadata", async () => {
    cookie = await loginActor(ownerActor, true);

    for (const kind of ["original", "preview"]) {
      const response = await bufferedRequest({
        method: "HEAD",
        path: downloadPath(largeMediaId, kind),
        headers: { cookie },
      });
      expect([404, 405]).toContain(response.statusCode);
      expect(response.headers["content-disposition"]).toBeUndefined();
    }
  });

  test("enforces the complete private authorization matrix through real HTTPS login", async () => {
    const ownerCookie = cookie || (await loginActor(ownerActor));
    await expectDownloadPair(ownerCookie, albumId, smallMediaId, 200);

    const familyCookie = await loginActor(familyActor);
    await expectDownloadPair(familyCookie, familyAlbumId, smallMediaId, 200);

    const explicitCookie = await loginActor(explicitActor);
    await expectDownloadPair(explicitCookie, albumId, smallMediaId, 200);
    await expectDownloadPair(explicitCookie, emptyAlbumId, smallMediaId, 404);

    await expectDownloadPair(familyCookie, albumId, smallMediaId, 404);

    const superAdminCookie = await loginActor(superAdminActor);
    await expectDownloadPair(
      superAdminCookie,
      hiddenAlbumId,
      smallMediaId,
      404,
    );

    const outsiderCookie = await loginActor(outsiderActor);
    await expectDownloadPair(outsiderCookie, albumId, smallMediaId, 404);

    await expectDownloadPair(ownerCookie, emptyAlbumId, smallMediaId, 404);

    await withRestoredMutation(
      "UPDATE family_members SET disabled_at=CURRENT_TIMESTAMP(3) WHERE id=?",
      "UPDATE family_members SET disabled_at=NULL WHERE id=?",
      familyActor.memberId,
      () => expectDownloadPair(familyCookie, familyAlbumId, smallMediaId, 401),
    );

    await withRestoredMutation(
      "UPDATE family_members SET left_at=CURRENT_TIMESTAMP(3) WHERE id=?",
      "UPDATE family_members SET left_at=NULL WHERE id=?",
      familyActor.memberId,
      () => expectDownloadPair(familyCookie, familyAlbumId, smallMediaId, 401),
    );

    await withRestoredMutation(
      "UPDATE users SET disabled_at=CURRENT_TIMESTAMP(3) WHERE id=?",
      "UPDATE users SET disabled_at=NULL WHERE id=?",
      familyActor.userId,
      () => expectDownloadPair(familyCookie, familyAlbumId, smallMediaId, 401),
    );

    await withRestoredMutation(
      "UPDATE media_items SET processing_state='BLOCKED',last_failure_code='MALFORMED_MEDIA' WHERE id=?",
      "UPDATE media_items SET processing_state='READY',last_failure_code=NULL WHERE id=?",
      smallMediaId,
      () => expectDownloadPair(ownerCookie, albumId, smallMediaId, 404),
    );

    const [revokedSessions] = await database.pool.query<RowDataPacket[]>(
      "SELECT CAST(id AS CHAR) id FROM sessions WHERE user_id=? AND revoked_at IS NULL ORDER BY id DESC LIMIT 1",
      [familyActor.userId],
    );
    const revokedSessionId = String(revokedSessions[0]?.id ?? "");
    expect(revokedSessionId.length > 0).toBe(true);
    await database.pool.query(
      "UPDATE sessions SET revoked_at=CURRENT_TIMESTAMP(3),revoke_reason='USER_REVOKE' WHERE id=?",
      [revokedSessionId],
    );
    await expectDownloadPair(familyCookie, familyAlbumId, smallMediaId, 401);
  }, 120_000);

  test("keeps sensitive assertion failures category-only", () => {
    const sentinel = `synthetic-${randomUUID()}`;
    let message = "";
    try {
      assertSensitiveCategoryAbsent(`captured:${sentinel}`, {
        category: "session-cookie",
        secret: sentinel,
      });
    } catch (error) {
      message = error instanceof Error ? error.message : "safe-unknown-error";
    }
    expect(message.includes(sentinel)).toBe(false);
    expect(message).toBe(
      "Sensitive category unexpectedly present: session-cookie",
    );
  });

  test("streams the exact 64 MiB Original with safe network headers", async () => {
    const result = await streamingHash(downloadPath(largeMediaId, "original"));
    expect(result.statusCode).toBe(200);
    expect(result.headers["content-length"]).toBe(String(largeBytes));
    expect(result.headers["content-type"]).toBe("image/jpeg");
    expect(result.headers["cache-control"]).toBe("private, no-store");
    expect(result.headers["x-content-type-options"]).toBe("nosniff");
    expect(result.headers["referrer-policy"]).toBe("no-referrer");
    expect(result.headers["accept-ranges"]).toBe("none");
    expect(result.headers["content-range"]).toBeUndefined();
    expect(result.received).toBe(largeBytes);
    assertSensitiveValuesEqual("large-original-sha", result.sha256, largeSha);
    expect(result.complete).toBe(true);

    const disposition = String(result.headers["content-disposition"]);
    expect(rawHeaderCount(result.rawHeaders, "content-disposition")).toBe(1);
    expect(disposition.match(/filename="/gu)).toHaveLength(1);
    expect(disposition.match(/filename\*=/gu)).toHaveLength(1);
    expect(disposition).not.toMatch(/[\r\n\0]/u);
    expect(disposition).not.toContain("X-Injected");
    expect(disposition).toContain(`filename="media-${largeMediaId}.jpg"`);
    expect(disposition).not.toMatch(/\.jpeg"/u);
    expect(Buffer.byteLength(disposition)).toBeLessThanOrEqual(512);
  }, 120_000);

  test("falls back to octet-stream/bin and ignores every Range form", async () => {
    await database.pool.query(
      "UPDATE media_items SET processing_state='PARTIAL',generation=2,metadata_generation=1 WHERE id=?",
      [smallMediaId],
    );
    try {
      for (const range of ["bytes=0-3", "bytes=-4", "bytes=0-2,5-7"]) {
        const result = await bufferedRequest({
          method: "GET",
          path: downloadPath(smallMediaId, "original"),
          headers: { cookie, range },
        });
        expect(result.statusCode).toBe(200);
        expect(result.headers["content-type"]).toBe("application/octet-stream");
        expect(result.headers["accept-ranges"]).toBe("none");
        expect(result.headers["content-range"]).toBeUndefined();
        expect(result.body.toString()).toBe("phase-6d5-small-original");
        expect(String(result.headers["content-disposition"])).toContain(
          `filename="media-${smallMediaId}.bin"`,
        );
      }
    } finally {
      await database.pool.query(
        "UPDATE media_items SET processing_state='READY',generation=1,metadata_generation=1 WHERE id=?",
        [smallMediaId],
      );
    }
  });

  test("serves private Preview exactly and ignores Range", async () => {
    const [sessions] = await database.pool.query<RowDataPacket[]>(
      "SELECT CAST(id AS CHAR) id,token_hash tokenHash FROM sessions WHERE user_id=? AND revoked_at IS NULL ORDER BY id DESC LIMIT 1",
      [userId],
    );
    const session = sessions[0];
    const authorized = await new MySqlAlbumRepository(
      database.pool,
    ).preparePreviewDownload({
      actor: {
        userId,
        sessionId: String(session?.id),
        tokenHash: session?.tokenHash as Buffer,
      },
      albumId,
      mediaId: largeMediaId,
    });
    expect(authorized).toMatchObject({
      mediaId: largeMediaId,
      byteSize: BigInt(previewBytes.length),
    });
    assertSensitiveValuesEqual(
      "preview-authorized-sha",
      authorized.sha256Hex,
      previewSha,
    );
    const previewIdentity = await fileIdentity(previewPath);
    expect(previewIdentity).toMatchObject({
      size: previewBytes.length,
      mode: expect.any(Number),
      nlink: 1,
    });
    assertSensitiveValuesEqual(
      "preview-file-sha",
      previewIdentity.sha256,
      previewSha,
    );
    expect(previewIdentity.mode & 0o777).toBe(0o400);
    const modeWithAcl = execFileSync("/bin/ls", ["-lde", previewPath], {
      encoding: "utf8",
    })
      .trim()
      .split(/\s+/u)[0];
    expect(modeWithAcl).not.toContain("+");
    const diagnosticGate = CapacityGate.open({
      mediaRoot,
      expectedMarkerId: markerId,
    });
    try {
      const bytes = await diagnosticGate.withLock(() =>
        Promise.resolve(
          diagnosticGate.readDerivedFinal({
            familyId,
            mediaId: largeMediaId,
            generation: 1n,
            recipeId: 1,
            kind: "PREVIEW",
            sha256Hex: previewSha,
            byteSize: BigInt(previewBytes.length),
          }),
        ),
      );
      expect(bytes.length).toBe(previewBytes.length);
    } finally {
      diagnosticGate.close();
    }
    for (const range of [undefined, "bytes=0-3", "bytes=-4", "bytes=0-2,5-7"]) {
      const result = await bufferedRequest({
        method: "GET",
        path: downloadPath(largeMediaId, "preview"),
        headers: { cookie, ...(range ? { range } : {}) },
      });
      expect(
        result.statusCode,
        `preview safe events: ${JSON.stringify(observedMediaEvents(largeMediaId))}`,
      ).toBe(200);
      expect(result.headers["content-type"]).toBe("image/webp");
      expect(result.headers["content-length"]).toBe(
        String(previewBytes.length),
      );
      expect(result.headers["content-disposition"]).toBe(
        `attachment; filename="media-${largeMediaId}-preview.webp"; filename*=UTF-8''media-${largeMediaId}-preview.webp`,
      );
      expect(result.headers["content-disposition"]).not.toContain("quote");
      expect(result.headers["cache-control"]).toBe("private, no-store");
      expect(result.headers["x-content-type-options"]).toBe("nosniff");
      expect(result.headers["referrer-policy"]).toBe("no-referrer");
      expect(result.headers["accept-ranges"]).toBe("none");
      expect(result.headers["content-range"]).toBeUndefined();
      expect(result.body.length).toBe(previewBytes.length);
      assertSensitiveValuesEqual(
        "preview-response-sha",
        createHash("sha256").update(result.body).digest("hex"),
        previewSha,
      );
    }
  }, 60_000);

  test("propagates real HTTPS Original abort and allows a later full download", async () => {
    const aborted = await abortAfterBody(
      downloadPath(largeMediaId, "original"),
    );
    expect(aborted.statusCode).toBe(200);
    expect(aborted.received).toBeGreaterThan(0);
    expect(aborted.received).toBeLessThan(largeBytes);
    await expect
      .poll(
        () => observedTransfer("ORIGINAL", largeMediaId, "TRANSFER_FAILED"),
        {
          timeout: 15_000,
        },
      )
      .toBe(true);

    const retry = await streamingHash(downloadPath(largeMediaId, "original"));
    expect(retry.statusCode).toBe(200);
    expect(retry.received).toBe(largeBytes);
    assertSensitiveValuesEqual("large-retry-sha", retry.sha256, largeSha);
    expect(retry.complete).toBe(true);
  }, 120_000);

  test("keeps the HTTPS API responsive while a consumer pauses and resumes", async () => {
    const transfer = pausedStreamingHash(
      downloadPath(largeMediaId, "original"),
    );
    await transfer.paused;
    const health = await bufferedRequest({
      method: "GET",
      path: "/api/v1/auth/me",
      headers: { cookie },
    });
    expect(health.statusCode).toBe(200);
    transfer.resume();
    const result = await transfer.result;
    expect(result.received).toBe(largeBytes);
    assertSensitiveValuesEqual("large-resume-sha", result.sha256, largeSha);
    expect(result.complete).toBe(true);
  }, 120_000);

  test("propagates real HTTPS Preview abort and preserves all canonical state", async () => {
    const aborted = await abortAfterBody(downloadPath(largeMediaId, "preview"));
    expect(aborted.statusCode).toBe(200);
    expect(aborted.received).toBeGreaterThan(0);
    expect(aborted.received).toBeLessThan(previewBytes.length);
    await expect
      .poll(
        () => observedTransfer("PREVIEW", largeMediaId, "TRANSFER_FAILED"),
        {
          timeout: 15_000,
        },
      )
      .toBe(true);

    const connection = await database.pool.getConnection();
    try {
      expect((await canonicalSnapshot(connection)) === beforeCanonical).toBe(
        true,
      );
    } finally {
      connection.release();
    }
    expect(
      JSON.stringify(await fileIdentity(largeOriginalPath)) ===
        JSON.stringify(beforeOriginal),
    ).toBe(true);
    expect(
      JSON.stringify(await fileIdentity(previewPath)) ===
        JSON.stringify(beforePreview),
    ).toBe(true);
  });

  test("application logs expose no private download material", async () => {
    await expect
      .poll(() => observedTransfer("ORIGINAL", largeMediaId, "SUCCESS"), {
        timeout: 15_000,
      })
      .toBe(true);
    const log = readFileSync(apiObservationLog, "utf8");
    assertSensitiveCategoryAbsent(log, {
      category: "source-filename",
      secret: hostileFilename,
    });
    assertSensitiveCategoryAbsent(log, {
      category: "original-sha",
      secret: largeSha,
    });
    assertSensitiveCategoryAbsent(log, {
      category: "storage-path",
      secret: mediaRoot,
    });
    assertSensitiveCategoryAbsent(log, {
      category: "session-cookie",
      secret: cookie,
    });
    assertSensitiveCategoryAbsent(log, {
      category: "password",
      secret: password,
    });
    assertSensitiveCategoryAbsent(log, {
      category: "authorization-field",
      secret: /authorization/iu,
    });
    assertSensitiveCategoryAbsent(log, {
      category: "cookie-field",
      secret: /cookie/iu,
    });
  });
});

function downloadPath(mediaId: string, kind: "original" | "preview") {
  return `/api/v1/albums/${albumId}/media/${mediaId}/download/${kind}`;
}

async function loginActor(actor: LoginActor, assertAttributes = false) {
  const body = JSON.stringify({
    username: actor.username,
    password: actor.password,
  });
  const login = await bufferedRequest({
    method: "POST",
    path: "/api/v1/auth/login",
    headers: {
      origin: "https://localhost:3443",
      "content-type": "application/json",
      "content-length": String(Buffer.byteLength(body)),
    },
    body,
  });
  expect(login.statusCode).toBe(204);
  const values = login.headers["set-cookie"];
  expect(Array.isArray(values) && values.length === 1).toBe(true);
  const parsed = parseSessionCookie(values?.[0] ?? "");
  if (assertAttributes) {
    expect(parsed.safe).toEqual({
      nameIsExpected: true,
      valueIsNonEmpty: true,
      secure: true,
      httpOnly: true,
      sameSiteLax: true,
      pathIsRoot: true,
      domainAbsent: true,
    });
  } else {
    expect(parsed.safe.nameIsExpected && parsed.safe.valueIsNonEmpty).toBe(
      true,
    );
  }
  return parsed.cookieHeader;
}

async function expectDownloadPair(
  sessionCookie: string,
  selectedAlbumId: string,
  selectedMediaId: string,
  expectedStatus: 200 | 401 | 404,
) {
  for (const kind of ["original", "preview"] as const) {
    const response = await bufferedRequest({
      method: "GET",
      path: `/api/v1/albums/${selectedAlbumId}/media/${selectedMediaId}/download/${kind}`,
      headers: { cookie: sessionCookie },
    });
    expect(response.statusCode).toBe(expectedStatus);
    if (expectedStatus === 200) {
      expect(response.headers["content-disposition"] !== undefined).toBe(true);
      expect(response.body.length > 0).toBe(true);
    } else {
      expect(response.headers["content-disposition"] === undefined).toBe(true);
      expect(response.headers["content-length"] === String(largeBytes)).toBe(
        false,
      );
    }
  }
}

async function withRestoredMutation(
  mutateSql: string,
  restoreSql: string,
  id: string,
  operation: () => Promise<void>,
) {
  await database.pool.query(mutateSql, [id]);
  try {
    await operation();
  } finally {
    await database.pool.query(restoreSql, [id]);
  }
}

async function insertLoginIdentity(
  connection: PoolConnection,
  identityFamilyId: string,
  label: string,
  role: "SUPER_ADMIN" | "ADMIN" | "MEMBER",
  passwordHash: string,
): Promise<LoginActor> {
  const actorUsername = `p6d5_${label}_${suffix}`;
  const [user] = await connection.query<ResultSetHeader>(
    `INSERT INTO users
       (username,username_normalized,password_hash,display_name,password_changed_at)
     VALUES (?,?,?,?,CURRENT_TIMESTAMP(3))`,
    [
      actorUsername,
      normalizeUsername(actorUsername).normalizedBytes,
      passwordHash,
      `Phase 6D5 ${label}`,
    ],
  );
  const actorUserId = String(user.insertId);
  const [member] = await connection.query<ResultSetHeader>(
    "INSERT INTO family_members (family_id,user_id,role) VALUES (?,?,?)",
    [identityFamilyId, actorUserId, role],
  );
  return {
    userId: actorUserId,
    memberId: String(member.insertId),
    username: actorUsername,
    password,
  };
}

async function insertAlbum(
  connection: PoolConnection,
  albumFamilyId: string,
  ownerMemberId: string,
  name: string,
  visibility: "CUSTOM" | "FAMILY",
) {
  const [album] = await connection.query<ResultSetHeader>(
    "INSERT INTO albums (family_id,owner_member_id,name,visibility) VALUES (?,?,?,?)",
    [albumFamilyId, ownerMemberId, name, visibility],
  );
  return String(album.insertId);
}

function emptyLoginActor(): LoginActor {
  return { userId: "", memberId: "", username: "", password: "" };
}

async function createLargeOriginal(connection: PoolConnection) {
  const uploadPublicId = randomBytes(16);
  const uploadId = uploadPublicId.toString("hex");
  const stagingPath = resolve(
    mediaRoot!,
    buildUploadPayloadPath(familyId, uploadId),
  );
  mkdirControlled(resolve(stagingPath, ".."));
  const descriptor = openSync(stagingPath, "wx", 0o600);
  const hash = createHash("sha256");
  try {
    for (let index = 0; index < largeBytes / chunkBytes; index += 1) {
      const chunk = Buffer.alloc(chunkBytes, index & 0xff);
      chunk.writeUInt32BE(index, 0);
      hash.update(chunk);
      writeAll(descriptor, chunk);
    }
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
  const sha256 = hash.digest("hex");
  const originalPath = resolve(
    mediaRoot!,
    buildOriginalPath(familyId, sha256, String(largeBytes)),
  );
  mkdirControlled(resolve(originalPath, ".."));
  renameSync(stagingPath, originalPath);
  chmodSync(originalPath, 0o400);
  const inserted = await insertMedia(
    connection,
    uploadPublicId,
    Buffer.from(sha256, "hex"),
    largeBytes,
    hostileFilename,
    "image/jpeg",
  );
  return {
    ...inserted,
    sha256,
    path: originalPath,
  };
}

async function createSmallOriginal(connection: PoolConnection) {
  const bytes = Buffer.from("phase-6d5-small-original");
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const uploadPublicId = randomBytes(16);
  const uploadId = uploadPublicId.toString("hex");
  const stagingPath = resolve(
    mediaRoot!,
    buildUploadPayloadPath(familyId, uploadId),
  );
  mkdirControlled(resolve(stagingPath, ".."));
  writeFileSync(stagingPath, bytes, { flag: "wx", mode: 0o600 });
  const originalPath = resolve(
    mediaRoot!,
    buildOriginalPath(familyId, sha256, String(bytes.length)),
  );
  mkdirControlled(resolve(originalPath, ".."));
  renameSync(stagingPath, originalPath);
  chmodSync(originalPath, 0o400);
  return insertMedia(
    connection,
    uploadPublicId,
    Buffer.from(sha256, "hex"),
    bytes.length,
    "unknown.extension.html",
    "image/jpeg",
  );
}

async function insertMedia(
  connection: PoolConnection,
  publicId: Buffer,
  sha: Buffer,
  byteSize: number,
  originalFilename: string,
  detectedMime: string,
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
     VALUES (?,?,?,?,?,?,'COMPLETE',?,CURRENT_TIMESTAMP(3),?,CURRENT_TIMESTAMP(3),
             DATE_ADD(CURRENT_TIMESTAMP(3),INTERVAL 1 DAY))`,
    [
      publicId,
      familyId,
      memberId,
      originalFilename,
      byteSize,
      byteSize,
      sha,
      storageObjectId,
    ],
  );
  const [media] = await connection.query<ResultSetHeader>(
    `INSERT INTO media_items
      (family_id,storage_object_id,source_upload_id,uploaded_at,timeline_key,
       media_type,detected_mime,processing_state,generation,recipe_id,metadata_generation)
     VALUES (?,?,?,CURRENT_TIMESTAMP(3),CURRENT_TIMESTAMP(3),'IMAGE',?,'READY',1,1,1)`,
    [familyId, storageObjectId, String(upload.insertId), detectedMime],
  );
  return {
    storageObjectId,
    sourceUploadId: String(upload.insertId),
    mediaId: String(media.insertId),
  };
}

async function createPreview(connection: PoolConnection, mediaId: string) {
  const [job] = await connection.query<ResultSetHeader>(
    `INSERT INTO background_jobs
      (family_id,media_id,generation,recipe_id,job_type,state,available_at)
     VALUES (?,?,1,1,'IMAGE_DERIVATIVES','QUEUED',CURRENT_TIMESTAMP(3))`,
    [familyId, mediaId],
  );
  await connection.query(
    `INSERT INTO derived_assets
      (family_id,media_id,generation,recipe_id,kind,state,reserved_bytes,byte_size,
       sha256,width,height,output_mime,producer_job_id,producer_lease_epoch,published_at)
     VALUES (?,?,1,1,'PREVIEW','READY',4194304,?,?,1,1,'image/webp',?,1,
             CURRENT_TIMESTAMP(3))`,
    [
      familyId,
      mediaId,
      previewBytes.length,
      Buffer.from(previewSha, "hex"),
      String(job.insertId),
    ],
  );
  const directory = resolve(
    mediaRoot!,
    "derived",
    familyId,
    mediaId,
    "r1",
    "g1",
  );
  mkdirSync(directory, { recursive: true });
  let current = resolve(mediaRoot!, "derived");
  for (const segment of [familyId, mediaId, "r1", "g1"]) {
    chmodSync(current, 0o700);
    current = resolve(current, segment);
  }
  chmodSync(directory, 0o700);
  const path = resolve(directory, "preview.webp");
  copyFileSync(
    resolve(
      rootDir,
      "packages/storage/vendor/libwebp/1.6.0/webp_js/test_webp_js.webp",
    ),
    path,
  );
  const descriptor = openSync(path, "w");
  try {
    writeAll(descriptor, previewBytes);
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
  chmodSync(path, 0o400);
  return path;
}

async function assertDevDatabase(connection: PoolConnection) {
  await connection.query("SET SESSION time_zone = '+00:00'");
  const [rows] = await connection.query<RowDataPacket[]>(
    `SELECT DATABASE() databaseName,VERSION() mysqlVersion,CURRENT_USER() currentUser,
            @@GLOBAL.innodb_native_foreign_keys nativeFk,
            @@SESSION.foreign_key_checks foreignKeyChecks`,
  );
  const row = rows[0];
  if (
    row?.databaseName !== "family_album_dev" ||
    !String(row.mysqlVersion).startsWith("9.7.2") ||
    String(row.currentUser).toLowerCase().startsWith("root@") ||
    String(row.nativeFk) !== "1" ||
    String(row.foreignKeyChecks) !== "1"
  ) {
    throw new Error("PHASE6D5_DEV_PREFLIGHT_FAILED");
  }
}

async function canonicalSnapshot(connection: PoolConnection) {
  const [rows] = await connection.query<RowDataPacket[]>(
    `SELECT
      (SELECT GROUP_CONCAT(CONCAT_WS(':',id,LOWER(HEX(sha256)),byte_size,key_version,state,
        COALESCE(UNIX_TIMESTAMP(durable_at),'NULL'),COALESCE(UNIX_TIMESTAMP(verified_at),'NULL'))
        ORDER BY id SEPARATOR '|') FROM storage_objects WHERE family_id=?) storageRows,
      (SELECT GROUP_CONCAT(CONCAT_WS(':',id,LOWER(HEX(public_id)),created_by_member_id,
        original_filename,declared_size,committed_offset,state,LOWER(HEX(computed_sha256)),
        storage_object_id) ORDER BY id SEPARATOR '|') FROM upload_sessions WHERE family_id=?) uploadRows,
      (SELECT GROUP_CONCAT(CONCAT_WS(':',id,storage_object_id,source_upload_id,processing_state,
        generation,recipe_id,COALESCE(metadata_generation,'NULL'),COALESCE(detected_mime,'NULL'))
        ORDER BY id SEPARATOR '|') FROM media_items WHERE family_id=?) mediaRows,
      (SELECT GROUP_CONCAT(CONCAT_WS(':',album_id,media_id) ORDER BY album_id,media_id SEPARATOR '|')
        FROM album_media WHERE family_id=?) placementRows,
      (SELECT GROUP_CONCAT(CONCAT_WS(':',id,media_id,generation,recipe_id,kind,state,byte_size,
        LOWER(HEX(sha256)),producer_job_id,producer_lease_epoch) ORDER BY id SEPARATOR '|')
        FROM derived_assets WHERE family_id=?) derivedRows,
      (SELECT GROUP_CONCAT(CONCAT_WS(':',id,media_id,generation,recipe_id,job_type,state,attempts,
        lease_epoch) ORDER BY id SEPARATOR '|') FROM background_jobs WHERE family_id=?) jobRows`,
    [familyId, familyId, familyId, familyId, familyId, familyId],
  );
  return JSON.stringify(rows[0]);
}

async function fileIdentity(path: string): Promise<FileIdentity> {
  const stat = lstatSync(path);
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path, {
    highWaterMark: chunkBytes,
  })) {
    hash.update(chunk as Buffer);
  }
  return {
    sha256: hash.digest("hex"),
    device: stat.dev,
    inode: stat.ino,
    mode: stat.mode,
    nlink: stat.nlink,
    size: stat.size,
    mtimeMs: stat.mtimeMs,
  };
}

function bufferedRequest(input: {
  method: string;
  path: string;
  headers?: Record<string, string>;
  body?: string;
}) {
  return new Promise<{
    statusCode: number;
    headers: IncomingHttpHeaders;
    rawHeaders: string[];
    body: Buffer;
  }>((resolvePromise, reject) => {
    const request = httpsRequest(
      {
        hostname: "localhost",
        port: 3443,
        method: input.method,
        path: input.path,
        headers: input.headers,
        agent: tlsAgent,
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
        response.on("end", () =>
          resolvePromise({
            statusCode: response.statusCode ?? 0,
            headers: response.headers,
            rawHeaders: response.rawHeaders,
            body: Buffer.concat(chunks),
          }),
        );
      },
    );
    request.once("error", reject);
    if (input.body) request.write(input.body);
    request.end();
  });
}

function streamingHash(path: string) {
  return new Promise<{
    statusCode: number;
    headers: IncomingHttpHeaders;
    rawHeaders: string[];
    received: number;
    sha256: string;
    complete: boolean;
  }>((resolvePromise, reject) => {
    const request = httpsRequest(
      {
        hostname: "localhost",
        port: 3443,
        path,
        headers: { cookie },
        agent: tlsAgent,
      },
      (response) => {
        const hash = createHash("sha256");
        let received = 0;
        let complete = false;
        response.on("data", (chunk: Buffer) => {
          received += chunk.length;
          hash.update(chunk);
        });
        response.on("end", () => {
          complete = response.complete;
          resolvePromise({
            statusCode: response.statusCode ?? 0,
            headers: response.headers,
            rawHeaders: response.rawHeaders,
            received,
            sha256: hash.digest("hex"),
            complete,
          });
        });
        response.once("error", reject);
      },
    );
    request.once("error", reject);
    request.end();
  });
}

function abortAfterBody(path: string) {
  return new Promise<{ statusCode: number; received: number }>(
    (resolvePromise, reject) => {
      const request = httpsRequest(
        {
          hostname: "localhost",
          port: 3443,
          path,
          headers: { cookie },
          agent: tlsAgent,
        },
        (response) => {
          let received = 0;
          let resolved = false;
          const finish = () => {
            if (resolved) return;
            resolved = true;
            resolvePromise({ statusCode: response.statusCode ?? 0, received });
          };
          response.on("data", (chunk: Buffer) => {
            received += chunk.length;
            if (received > 0) {
              response.destroy();
              request.destroy();
              finish();
            }
          });
          response.once("close", finish);
          response.once("error", finish);
        },
      );
      request.once("error", (error) => {
        if ((error as NodeJS.ErrnoException).code !== "ECONNRESET")
          reject(error);
      });
      request.end();
    },
  );
}

function pausedStreamingHash(path: string) {
  let resume!: () => void;
  let markPaused!: () => void;
  const paused = new Promise<void>((done) => (markPaused = done));
  const resumeGate = new Promise<void>((done) => (resume = done));
  const result = new Promise<{
    received: number;
    sha256: string;
    complete: boolean;
  }>((resolvePromise, reject) => {
    const request = httpsRequest(
      {
        hostname: "localhost",
        port: 3443,
        path,
        headers: { cookie },
        agent: tlsAgent,
      },
      (response) => {
        const hash = createHash("sha256");
        let received = 0;
        let didPause = false;
        response.on("data", (chunk: Buffer) => {
          received += chunk.length;
          hash.update(chunk);
          if (!didPause) {
            didPause = true;
            response.pause();
            markPaused();
            void resumeGate.then(() => response.resume());
          }
        });
        response.on("end", () =>
          resolvePromise({
            received,
            sha256: hash.digest("hex"),
            complete: response.complete,
          }),
        );
        response.once("error", reject);
      },
    );
    request.once("error", reject);
    request.end();
  });
  return { paused, resume, result };
}

function rawHeaderCount(rawHeaders: string[], name: string) {
  let count = 0;
  for (let index = 0; index < rawHeaders.length; index += 2) {
    if (rawHeaders[index]?.toLowerCase() === name) count += 1;
  }
  return count;
}

function observedTransfer(
  kind: "ORIGINAL" | "PREVIEW",
  mediaId: string,
  resultCode: "SUCCESS" | "TRANSFER_FAILED",
) {
  let log: string;
  try {
    log = readFileSync(apiObservationLog!, "utf8");
  } catch {
    return false;
  }
  return log.split("\n").some((line) => {
    try {
      const event = JSON.parse(line) as Record<string, unknown>;
      return (
        event.event === "media_download" &&
        event.kind === kind &&
        String(event.mediaId) === mediaId &&
        event.resultCode === resultCode
      );
    } catch {
      return false;
    }
  });
}

function observedMediaEvents(mediaId: string) {
  let log: string;
  try {
    log = readFileSync(apiObservationLog!, "utf8");
  } catch {
    return [];
  }
  return log.split("\n").flatMap((line) => {
    try {
      const event = JSON.parse(line) as Record<string, unknown>;
      if (
        String(event.mediaId) !== mediaId &&
        event.event !== "media_preview_download"
      ) {
        return [];
      }
      return [
        {
          event: event.event,
          kind: event.kind,
          resultCode: event.resultCode,
          errorCategory: event.errorCategory,
        },
      ];
    } catch {
      return [];
    }
  });
}

function mkdirControlled(directory: string) {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  let current = directory;
  while (current.startsWith(mediaRoot!) && current !== mediaRoot) {
    chmodSync(current, 0o700);
    current = resolve(current, "..");
  }
}

function writeAll(descriptor: number, bytes: Buffer) {
  let offset = 0;
  while (offset < bytes.length) {
    offset += writeSync(descriptor, bytes, offset, bytes.length - offset);
  }
}
