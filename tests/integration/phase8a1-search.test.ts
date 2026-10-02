import { mkdirSync, writeFileSync } from "node:fs";
import { performance } from "node:perf_hooks";
import { randomBytes, randomUUID } from "node:crypto";

import type { ResultSetHeader, RowDataPacket } from "mysql2/promise";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  AlbumRepositoryError,
  assertMigrationReadiness,
  createDatabase,
  MySqlAlbumRepository,
  MySqlDerivedReadRepository,
  buildFamilySearchQuery,
} from "../../packages/db/src/index.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("PHASE8A1_SEARCH_DEV_DATABASE_URL_REQUIRED");

describe.sequential("Phase 8A1 authorized search", () => {
  const database = createDatabase(databaseUrl);
  const albums = new MySqlAlbumRepository(database.pool);
  const derived = new MySqlDerivedReadRepository(database.pool);
  const suffix = randomUUID().replaceAll("-", "");
  const tokenHash = randomBytes(32);
  const outsiderHash = randomBytes(32);
  const performanceUserIds: string[] = [];
  let familyId = "";
  let otherFamilyId = "",
    otherFamilyAlbum = "";
  let viewerUserId = "";
  let viewerSessionId = "";
  let outsiderUserId = "";
  let outsiderSessionId = "";
  let viewerMember = "",
    otherMember = "",
    otherUserId = "";
  let lowAlbum = "";
  let highAlbum = "";
  let hiddenAlbum = "";
  let deletedAlbum = "";
  let olderMedia = "";
  let newerMedia = "";
  let hiddenMedia = "";
  let deletedMedia = "";

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
        throw new Error("PHASE8A1_SEARCH_DEV_PREFLIGHT_FAILED");
      }
      await assertMigrationReadiness(connection);
      const [family] = await connection.query<ResultSetHeader>(
        "INSERT INTO families (name) VALUES (?)",
        [`Phase 8A1 search ${suffix}`],
      );
      familyId = String(family.insertId);
      viewerUserId = await insertUser(connection, `p8as_v_${suffix}`);
      otherUserId = await insertUser(connection, `p8as_o_${suffix}`);
      outsiderUserId = await insertUser(connection, `p8as_x_${suffix}`);
      viewerMember = await insertMember(connection, familyId, viewerUserId);
      otherMember = await insertMember(connection, familyId, otherUserId);
      viewerSessionId = await insertSession(
        connection,
        viewerUserId,
        tokenHash,
      );
      const [otherFamily] = await connection.query<ResultSetHeader>(
        "INSERT INTO families(name) VALUES(?)",
        [`Phase 8A1 isolated other ${suffix}`],
      );
      otherFamilyId = String(otherFamily.insertId);
      const foreignMember = await insertMember(
        connection,
        otherFamilyId,
        outsiderUserId,
      );
      otherFamilyAlbum = await insertAlbum(
        connection,
        otherFamilyId,
        foreignMember,
        "Other-family",
      );
      outsiderSessionId = await insertSession(
        connection,
        outsiderUserId,
        outsiderHash,
      );
      lowAlbum = await insertAlbum(connection, familyId, viewerMember, "Low");
      highAlbum = await insertAlbum(connection, familyId, viewerMember, "High");
      hiddenAlbum = await insertAlbum(
        connection,
        familyId,
        otherMember,
        "Hidden",
      );
      deletedAlbum = await insertAlbum(
        connection,
        familyId,
        viewerMember,
        "Deleted",
      );
      olderMedia = await insertMedia(
        connection,
        familyId,
        viewerMember,
        "2020-01-01 00:00:00.000",
      );
      newerMedia = await insertMedia(
        connection,
        familyId,
        viewerMember,
        "2024-06-01 00:00:00.000",
        {
          width: 320,
          height: 240,
          latitude: "37.780000",
          longitude: "-122.420000",
        },
      );
      hiddenMedia = await insertMedia(
        connection,
        familyId,
        viewerMember,
        "2023-01-01 00:00:00.000",
      );
      deletedMedia = await insertMedia(
        connection,
        familyId,
        viewerMember,
        "2022-01-01 00:00:00.000",
      );
      await connection.query(
        `INSERT INTO album_media (family_id, album_id, media_id)
         VALUES (?,?,?),(?,?,?),(?,?,?),(?,?,?),(?,?,?)`,
        [
          familyId,
          lowAlbum,
          olderMedia,
          familyId,
          lowAlbum,
          newerMedia,
          familyId,
          highAlbum,
          newerMedia,
          familyId,
          hiddenAlbum,
          hiddenMedia,
          familyId,
          deletedAlbum,
          deletedMedia,
        ],
      );
      await connection.query(
        "UPDATE albums SET deleted_at = CURRENT_TIMESTAMP(3) WHERE id = ?",
        [deletedAlbum],
      );
    } finally {
      connection.release();
    }
  });

  afterAll(async () => {
    if (familyId) {
      await database.pool.query(
        "UPDATE media_items SET purge_intent_id=NULL WHERE family_id=?",
        [familyId],
      );
      await database.pool.query("DELETE FROM purge_intents WHERE family_id=?", [
        familyId,
      ]);
      await database.pool.query(
        "DELETE FROM user_favorites WHERE family_id=?",
        [familyId],
      );
      await database.pool.query(
        "DELETE FROM family_featured WHERE family_id=?",
        [familyId],
      );
      await database.pool.query("DELETE FROM album_members WHERE family_id=?", [
        familyId,
      ]);
      await database.pool.query("DELETE FROM album_media WHERE family_id = ?", [
        familyId,
      ]);
      await database.pool.query("DELETE FROM media_items WHERE family_id = ?", [
        familyId,
      ]);
      await database.pool.query(
        "DELETE FROM upload_sessions WHERE family_id = ?",
        [familyId],
      );
      await database.pool.query(
        "DELETE FROM storage_objects WHERE family_id = ?",
        [familyId],
      );
      await database.pool.query("DELETE FROM albums WHERE family_id = ?", [
        familyId,
      ]);
      await database.pool.query(
        "DELETE FROM sessions WHERE user_id IN (?, ?)",
        [viewerUserId, outsiderUserId],
      );
      await database.pool.query(
        "DELETE FROM family_members WHERE family_id = ?",
        [familyId],
      );
      if (otherFamilyId) {
        await database.pool.query("DELETE FROM albums WHERE family_id=?", [
          otherFamilyId,
        ]);
        await database.pool.query(
          "DELETE FROM family_members WHERE family_id=?",
          [otherFamilyId],
        );
        await database.pool.query("DELETE FROM families WHERE id=?", [
          otherFamilyId,
        ]);
      }
      for (const id of performanceUserIds)
        await database.pool.query("DELETE FROM users WHERE id=?", [id]);
      await database.pool.query(
        "DELETE FROM users WHERE username IN (?, ?, ?)",
        [`p8as_v_${suffix}`, `p8as_o_${suffix}`, `p8as_x_${suffix}`],
      );
      await database.pool.query("DELETE FROM families WHERE id = ?", [
        familyId,
      ]);
    }
    await database.pool.end();
  });

  function viewer() {
    return { userId: viewerUserId, sessionId: viewerSessionId, tokenHash };
  }

  it("orders the visible timeline, dedupes albums, and pages with a cursor", async () => {
    const first = await albums.listFamilyTimeline({
      actor: viewer(),
      familyId,
      limit: 1,
    });
    expect(first).toHaveLength(1);
    expect(first[0]).toMatchObject({
      mediaId: newerMedia,
      albumId: lowAlbum,
      timelineBasis: "UPLOAD_UTC",
      displayWidth: 320,
      displayHeight: 240,
    });
    expect(first[0]).not.toHaveProperty("gpsLatitude");
    expect(JSON.stringify(first[0])).not.toContain("-122.420000");

    const second = await albums.listFamilyTimeline({
      actor: viewer(),
      familyId,
      limit: 20,
      cursor: {
        timelineKey: first[0]!.timelineKey,
        mediaId: first[0]!.mediaId,
      },
    });
    expect(second.map((row) => row.mediaId)).toEqual([olderMedia]);
    const ids = [first[0]!.mediaId, ...second.map((row) => row.mediaId)];
    expect(ids).not.toContain(hiddenMedia);
    expect(ids).not.toContain(deletedMedia);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("rejects a non-member and keeps derived bytes on the existing read", async () => {
    await expect(
      albums.listFamilyTimeline({
        actor: {
          userId: outsiderUserId,
          sessionId: outsiderSessionId,
          tokenHash: outsiderHash,
        },
        familyId,
        limit: 20,
      }),
    ).rejects.toBeInstanceOf(AlbumRepositoryError);

    const detail = await albums.getAlbumMedia({
      actor: viewer(),
      albumId: lowAlbum,
      mediaId: newerMedia,
    });
    expect(detail.mediaId).toBe(newerMedia);
    await expect(
      albums.getAlbumMedia({
        actor: viewer(),
        albumId: hiddenAlbum,
        mediaId: newerMedia,
      }),
    ).rejects.toMatchObject({ reason: "NOT_FOUND" });

    const bytes = await derived.findViewableReadyDerived({
      userId: viewerUserId,
      mediaId: newerMedia,
      kind: "THUMBNAIL",
    });
    expect(bytes).toBeNull();
  });
  const search = (
    filters: Parameters<typeof albums.searchFamilyMedia>[0]["filters"] = {},
    cursor?: { timelineKey: Date; mediaId: string },
    limit = 21,
  ) =>
    albums.searchFamilyMedia({
      actor: viewer(),
      familyId,
      limit,
      filters,
      ...(cursor ? { cursor } : {}),
    });

  it("matches all eight AND filter combinations before keyset paging", async () => {
    await database.pool.query(
      "INSERT INTO user_favorites(family_id,member_id,media_id) VALUES(?,?,?),(?,?,?)",
      [familyId, viewerMember, newerMedia, familyId, otherMember, olderMedia],
    );
    try {
      for (let bits = 0; bits < 8; bits++) {
        const rows = await search({
          ...(bits & 1
            ? {
                fromDate: new Date("2024-01-01T00:00:00.000Z"),
                toDate: new Date("2024-12-31T23:59:59.999Z"),
              }
            : {}),
          ...(bits & 2 ? { albumId: highAlbum } : {}),
          favoritesOnly: !!(bits & 4),
        });
        expect(rows.map((r) => r.mediaId)).toEqual(
          bits ? [newerMedia] : [newerMedia, olderMedia],
        );
        if (bits & 2) expect(rows[0]!.albumId).toBe(highAlbum);
      }
      expect(
        (await search({ favoritesOnly: true })).map((r) => r.mediaId),
      ).not.toContain(olderMedia);
      await database.pool.query(
        "DELETE FROM user_favorites WHERE family_id=? AND member_id=?",
        [familyId, viewerMember],
      );
      expect(await search({ favoritesOnly: true })).toEqual([]);
    } finally {
      await database.pool.query(
        "DELETE FROM user_favorites WHERE family_id=?",
        [familyId],
      );
    }
  });

  it("cannot infer a hidden placement or missing/cross-family album through a visible photo", async () => {
    await database.pool.query(
      "INSERT INTO album_media(family_id,album_id,media_id) VALUES(?,?,?)",
      [familyId, hiddenAlbum, newerMedia],
    );
    try {
      expect((await search()).map((r) => r.mediaId)).toEqual([
        newerMedia,
        olderMedia,
      ]);
      expect(await search({ albumId: hiddenAlbum })).toEqual([]);
      expect(await search({ albumId: otherFamilyAlbum })).toEqual([]);
      expect(await search({ albumId: "18446744073709551615" })).toEqual([]);
      expect(
        (await search({ albumId: lowAlbum })).map((r) => r.albumId),
      ).toEqual([lowAlbum, lowAlbum]);
    } finally {
      await database.pool.query(
        "DELETE FROM album_media WHERE family_id=? AND album_id=? AND media_id=?",
        [familyId, hiddenAlbum, newerMedia],
      );
    }
  });

  it("keeps ADMIN and SUPER_ADMIN outside a hidden CUSTOM album, grants only current view", async () => {
    try {
      for (const role of ["MEMBER", "ADMIN", "SUPER_ADMIN"]) {
        await database.pool.query(
          "UPDATE family_members SET role=? WHERE family_id=? AND id=?",
          [role, familyId, viewerMember],
        );
        expect(await search({ albumId: hiddenAlbum })).toEqual([]);
      }
      await database.pool.query(
        "INSERT INTO album_members(family_id,album_id,member_id,can_view) VALUES(?,?,?,1)",
        [familyId, hiddenAlbum, viewerMember],
      );
      expect(
        (await search({ albumId: hiddenAlbum })).map((r) => r.mediaId),
      ).toEqual([hiddenMedia]);
      await database.pool.query(
        "UPDATE album_members SET can_view=0 WHERE family_id=? AND album_id=? AND member_id=?",
        [familyId, hiddenAlbum, viewerMember],
      );
      expect(await search({ albumId: hiddenAlbum })).toEqual([]);
      await database.pool.query(
        "UPDATE albums SET visibility='FAMILY' WHERE family_id=? AND id=?",
        [familyId, hiddenAlbum],
      );
      expect(
        (await search({ albumId: hiddenAlbum })).map((r) => r.mediaId),
      ).toEqual([hiddenMedia]);
    } finally {
      await database.pool.query(
        "UPDATE family_members SET role='MEMBER' WHERE family_id=? AND id=?",
        [familyId, viewerMember],
      );
      await database.pool.query(
        "UPDATE albums SET visibility='CUSTOM' WHERE family_id=? AND id=?",
        [familyId, hiddenAlbum],
      );
      await database.pool.query("DELETE FROM album_members WHERE family_id=?", [
        familyId,
      ]);
    }
  });

  it("uses inclusive millisecond calendar bounds, capture-local and upload fallback", async () => {
    try {
      await database.pool.query(
        "UPDATE media_items SET captured_local_at='2024-02-29 00:00:00.000',captured_source='EXIF_ORIGINAL',captured_time_status='OFFSET_UNKNOWN',timeline_basis='CAPTURE_LOCAL',timeline_key='2024-02-29 00:00:00.000' WHERE family_id=? AND id=?",
        [familyId, olderMedia],
      );
      await database.pool.query(
        "UPDATE media_items SET uploaded_at='2024-02-29 23:59:59.999',timeline_key='2024-02-29 23:59:59.999' WHERE family_id=? AND id=?",
        [familyId, newerMedia],
      );
      const bounds = {
        fromDate: new Date("2024-02-29T00:00:00.000Z"),
        toDate: new Date("2024-02-29T23:59:59.999Z"),
      };
      const rows = await search(bounds);
      expect(rows.map((r) => r.mediaId)).toEqual([newerMedia, olderMedia]);
      expect(rows[1]!.timelineBasis).toBe("CAPTURE_LOCAL");
      expect(
        (await search({ fromDate: bounds.toDate })).map((r) => r.mediaId),
      ).toEqual([newerMedia]);
      expect(
        (await search({ toDate: bounds.fromDate })).map((r) => r.mediaId),
      ).toEqual([olderMedia]);
    } finally {
      await database.pool.query(
        "UPDATE media_items SET captured_local_at=NULL,captured_source='NONE',captured_time_status='ABSENT',timeline_basis='UPLOAD_UTC',uploaded_at=?,timeline_key=? WHERE family_id=? AND id=?",
        [
          "2020-01-01 00:00:00.000",
          "2020-01-01 00:00:00.000",
          familyId,
          olderMedia,
        ],
      );
      await database.pool.query(
        "UPDATE media_items SET uploaded_at='2024-06-01 00:00:00.000',timeline_key='2024-06-01 00:00:00.000' WHERE family_id=? AND id=?",
        [familyId, newerMedia],
      );
    }
  });

  it("does not resurrect trashed or purge-intent media through favorites; restores current placement", async () => {
    await database.pool.query(
      "INSERT INTO user_favorites(family_id,member_id,media_id) VALUES(?,?,?)",
      [familyId, viewerMember, newerMedia],
    );
    try {
      await database.pool.query(
        "UPDATE media_items SET trashed_at=CURRENT_TIMESTAMP(3),trashed_by_member_id=?,purge_after=DATE_ADD(CURRENT_TIMESTAMP(3),INTERVAL 30 DAY),lifecycle_revision=2 WHERE family_id=? AND id=?",
        [viewerMember, familyId, newerMedia],
      );
      expect(await search({ favoritesOnly: true })).toEqual([]);
      const [intent] = await database.pool.query<ResultSetHeader>(
        `INSERT INTO purge_intents(family_id,operation_id,media_id,storage_object_id,source_upload_id,lifecycle_revision,trashed_at,purge_after,request_source,actor_member_id,original_bytes)
      SELECT family_id,?,id,storage_object_id,source_upload_id,lifecycle_revision,trashed_at,purge_after,'MANUAL',?,8 FROM media_items WHERE family_id=? AND id=?`,
        [randomUUID(), viewerMember, familyId, newerMedia],
      );
      await database.pool.query(
        "UPDATE media_items SET purge_intent_id=? WHERE family_id=? AND id=?",
        [String(intent.insertId), familyId, newerMedia],
      );
      expect(await search()).toHaveLength(1);
      await database.pool.query(
        "UPDATE media_items SET purge_intent_id=NULL,trashed_at=NULL,trashed_by_member_id=NULL,purge_after=NULL WHERE family_id=? AND id=?",
        [familyId, newerMedia],
      );
      expect(
        (await search({ favoritesOnly: true })).map((r) => r.mediaId),
      ).toEqual([newerMedia]);
      await database.pool.query(
        "DELETE FROM album_media WHERE family_id=? AND media_id=?",
        [familyId, newerMedia],
      );
      expect(await search({ favoritesOnly: true })).toEqual([]);
    } finally {
      await database.pool.query(
        "UPDATE media_items SET purge_intent_id=NULL,trashed_at=NULL,trashed_by_member_id=NULL,purge_after=NULL WHERE family_id=? AND id=?",
        [familyId, newerMedia],
      );
      await database.pool.query("DELETE FROM purge_intents WHERE family_id=?", [
        familyId,
      ]);
      await database.pool.query(
        "DELETE FROM user_favorites WHERE family_id=?",
        [familyId],
      );
      await database.pool.query(
        "INSERT IGNORE INTO album_media(family_id,album_id,media_id) VALUES(?,?,?),(?,?,?)",
        [familyId, lowAlbum, newerMedia, familyId, highAlbum, newerMedia],
      );
    }
  });

  it("keeps equal timestamp numeric keysets stable and does not require the boundary row", async () => {
    const tie = await database.pool.query(
      "UPDATE media_items SET uploaded_at='2024-06-01 00:00:00.000',timeline_key='2024-06-01 00:00:00.000' WHERE family_id=? AND id=?",
      [familyId, olderMedia],
    );
    void tie;
    try {
      const first = await search({}, undefined, 1);
      expect(first[0]!.mediaId).toBe(newerMedia);
      await database.pool.query(
        "DELETE FROM album_media WHERE family_id=? AND media_id=?",
        [familyId, newerMedia],
      );
      expect(
        (
          await search(
            {},
            { timelineKey: first[0]!.timelineKey, mediaId: first[0]!.mediaId },
            1,
          )
        ).map((r) => r.mediaId),
      ).toEqual([olderMedia]);
    } finally {
      await database.pool.query(
        "UPDATE media_items SET uploaded_at='2020-01-01 00:00:00.000',timeline_key='2020-01-01 00:00:00.000' WHERE family_id=? AND id=?",
        [familyId, olderMedia],
      );
      await database.pool.query(
        "INSERT IGNORE INTO album_media(family_id,album_id,media_id) VALUES(?,?,?),(?,?,?)",
        [familyId, lowAlbum, newerMedia, familyId, highAlbum, newerMedia],
      );
    }
  });

  it("revalidates a waiting search after family-locked session revocation", async () => {
    const connection = await database.pool.getConnection();
    await connection.beginTransaction();
    try {
      await connection.query("SELECT id FROM families WHERE id=? FOR UPDATE", [
        familyId,
      ]);
      let complete = false;
      const pending = search().finally(() => {
        complete = true;
      });
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(complete).toBe(false);
      await connection.query(
        "UPDATE sessions SET revoked_at=CURRENT_TIMESTAMP(3),revoke_reason='LOGOUT' WHERE id=?",
        [viewerSessionId],
      );
      await connection.commit();
      await expect(pending).rejects.toBeInstanceOf(AlbumRepositoryError);
    } finally {
      await connection.rollback();
      connection.release();
      await database.pool.query(
        "UPDATE sessions SET revoked_at=NULL,revoke_reason=NULL WHERE id=?",
        [viewerSessionId],
      );
    }
  });

  it("rejects another family and disabled current actor", async () => {
    await expect(
      albums.searchFamilyMedia({
        actor: viewer(),
        familyId: otherFamilyId,
        limit: 21,
        filters: {},
      }),
    ).rejects.toMatchObject({ reason: "NOT_FOUND" });
    await database.pool.query(
      "UPDATE users SET disabled_at=CURRENT_TIMESTAMP(3) WHERE id=?",
      [viewerUserId],
    );
    try {
      await expect(search()).rejects.toBeInstanceOf(AlbumRepositoryError);
    } finally {
      await database.pool.query(
        "UPDATE users SET disabled_at=NULL WHERE id=?",
        [viewerUserId],
      );
    }
  });
  it("lists only authorized live album options, including a visible empty album", async () => {
    const c = await database.pool.getConnection();
    let emptyAlbum: string;
    try {
      emptyAlbum = await insertAlbum(
        c,
        familyId,
        viewerMember,
        "Empty-visible",
      );
      for (let n = 0; n < 50; n++)
        await insertAlbum(c, familyId, viewerMember, `Empty-visible-${n}`);
    } finally {
      c.release();
    }
    const options = await albums.listAlbums({
      actor: viewer(),
      familyId,
      limit: 50,
    });
    expect(options).toHaveLength(50);
    const remaining = await albums.listAlbums({
      actor: viewer(),
      familyId,
      limit: 50,
      afterId: options.at(-1)!.id,
    });
    expect(remaining).toHaveLength(3);
    const allOptions = options.concat(remaining);
    expect(new Set(allOptions.map((row) => row.id)).size).toBe(53);
    expect(allOptions.map((row) => row.id)).toContain(emptyAlbum);
    for (const forbidden of [hiddenAlbum, deletedAlbum, otherFamilyAlbum])
      expect(allOptions.map((row) => row.id)).not.toContain(forbidden);
    expect(await search({ albumId: emptyAlbum })).toEqual([]);
  });

  it("keeps unsigned BIGINT codec and millisecond keysets exact without changing DEV AUTO_INCREMENT", async () => {
    const ids = [
      "18446744073709551615",
      "9007199254740994",
      "9007199254740993",
    ];
    const sql = `WITH synthetic_ids AS (SELECT CAST(? AS UNSIGNED) id UNION ALL SELECT CAST(? AS UNSIGNED) UNION ALL SELECT CAST(? AS UNSIGNED)) SELECT CAST(id AS CHAR) mediaId FROM synthetic_ids WHERE id < CAST(? AS UNSIGNED) ORDER BY id DESC LIMIT 2`;
    const [rows] = await database.pool.query<RowDataPacket[]>(sql, [
      ...ids,
      ids[0],
    ]);
    expect(rows.map((row) => row.mediaId)).toEqual(ids.slice(1));
    const query = buildFamilySearchQuery(
      familyId,
      viewerMember,
      2,
      { timelineKey: new Date("2024-06-01T00:00:00.000Z"), mediaId: ids[0]! },
      {},
    );
    expect(query.values[7]).toBe(ids[0]);
  });

  it("records bounded 10k-media/5-member EXPLAIN and search latency without new indexes", async () => {
    const c = await database.pool.getConnection();
    try {
      for (let n = 0; n < 3; n++) {
        const id = await insertUser(c, `p8as_perf_${n}_${suffix}`);
        performanceUserIds.push(id);
        await insertMember(c, familyId, id);
      }
      const [maxObjectRows] = await c.query<RowDataPacket[]>(
        "SELECT COALESCE(MAX(id),0) id FROM storage_objects WHERE family_id=?",
        [familyId],
      );
      const [maxUploadRows] = await c.query<RowDataPacket[]>(
        "SELECT COALESCE(MAX(id),0) id FROM upload_sessions WHERE family_id=?",
        [familyId],
      );
      const [maxMediaRows] = await c.query<RowDataPacket[]>(
        "SELECT COALESCE(MAX(id),0) id FROM media_items WHERE family_id=?",
        [familyId],
      );
      const digits =
        "(SELECT 0 n UNION ALL SELECT 1 UNION ALL SELECT 2 UNION ALL SELECT 3 UNION ALL SELECT 4 UNION ALL SELECT 5 UNION ALL SELECT 6 UNION ALL SELECT 7 UNION ALL SELECT 8 UNION ALL SELECT 9)";
      const sequence = `(SELECT a.n+10*b.n+100*d.n+1000*e.n n FROM ${digits} a CROSS JOIN ${digits} b CROSS JOIN ${digits} d CROSS JOIN ${digits} e)`;
      await c.query(
        `INSERT INTO storage_objects(family_id,sha256,byte_size,key_version,state,durable_at,verified_at)
        SELECT ?,UNHEX(SHA2(CONCAT('p8a1-perf-',?,numbers.n),256)),8,1,'AVAILABLE',CURRENT_TIMESTAMP(3),CURRENT_TIMESTAMP(3) FROM ${sequence} numbers`,
        [familyId, suffix],
      );
      await c.query(
        `INSERT INTO upload_sessions(public_id,family_id,created_by_member_id,original_filename,declared_size,committed_offset,state,computed_sha256,finalize_started_at,storage_object_id,completed_at,expires_at)
        SELECT UNHEX(SUBSTRING(SHA2(CONCAT(?,s.id),256),1,32)),s.family_id,?,'synthetic-perf.png',8,8,'COMPLETE',s.sha256,CURRENT_TIMESTAMP(3),s.id,CURRENT_TIMESTAMP(3),DATE_ADD(CURRENT_TIMESTAMP(3),INTERVAL 1 DAY)
        FROM storage_objects s WHERE s.family_id=? AND s.id>?`,
        [suffix, viewerMember, familyId, String(maxObjectRows[0]!.id)],
      );
      await c.query(
        `INSERT INTO media_items(family_id,storage_object_id,source_upload_id,uploaded_at,timeline_key)
        SELECT family_id,storage_object_id,id,DATE_ADD('2020-01-01',INTERVAL MOD(id,1461) DAY),DATE_ADD('2020-01-01',INTERVAL MOD(id,1461) DAY)
        FROM upload_sessions WHERE family_id=? AND id>?`,
        [familyId, String(maxUploadRows[0]!.id)],
      );
      await c.query(
        `INSERT INTO album_media(family_id,album_id,media_id) SELECT family_id,IF(MOD(id,2)=0,?,?),id FROM media_items WHERE family_id=? AND id>?`,
        [lowAlbum, hiddenAlbum, familyId, String(maxMediaRows[0]!.id)],
      );
      await c.query(
        `INSERT INTO album_media(family_id,album_id,media_id) SELECT family_id,?,id FROM media_items WHERE family_id=? AND id>? AND MOD(id,4)=0`,
        [highAlbum, familyId, String(maxMediaRows[0]!.id)],
      );
      await c.query(
        `INSERT INTO user_favorites(family_id,member_id,media_id) SELECT family_id,IF(MOD(id,20)=0,?,?),id FROM media_items WHERE family_id=? AND id>? AND MOD(id,5)=0`,
        [viewerMember, otherMember, familyId, String(maxMediaRows[0]!.id)],
      );
      const [count] = await c.query<RowDataPacket[]>(
        "SELECT COUNT(*) n FROM media_items WHERE family_id=? AND id>?",
        [familyId, String(maxMediaRows[0]!.id)],
      );
      expect(Number(count[0]!.n)).toBe(10000);
      const baselineStart = performance.now();
      const baseline = await albums.listFamilyTimeline({
        actor: viewer(),
        familyId,
        limit: 25,
      });
      const baselineMs = performance.now() - baselineStart;
      const cases = [];
      for (let bits = 0; bits < 8; bits++) {
        const filters = {
          ...(bits & 1
            ? {
                fromDate: new Date("2022-01-01T00:00:00.000Z"),
                toDate: new Date("2022-01-01T23:59:59.999Z"),
              }
            : {}),
          ...(bits & 2 ? { albumId: lowAlbum } : {}),
          favoritesOnly: !!(bits & 4),
        };
        for (const depth of ["first", "deep"]) {
          const cursor =
            depth === "deep"
              ? {
                  timelineKey: new Date("2021-06-01T00:00:00.000Z"),
                  mediaId: "18446744073709551615",
                }
              : undefined;
          const query = buildFamilySearchQuery(
            familyId,
            viewerMember,
            25,
            cursor,
            filters,
          );
          const [plan] = await c.query<RowDataPacket[]>(
            "EXPLAIN " + query.sql,
            query.values,
          );
          const [actualPlan] = await c.query<RowDataPacket[]>(
            "EXPLAIN ANALYZE " + query.sql,
            query.values,
          );
          const start = performance.now();
          const rows = await search(filters, cursor, 25);
          const elapsedMs = performance.now() - start;
          expect(rows.length).toBeLessThanOrEqual(25);
          expect(new Set(rows.map((row) => row.mediaId)).size).toBe(
            rows.length,
          );
          expect(elapsedMs).toBeLessThan(10000);
          cases.push({
            combination: bits,
            depth,
            sql: query.sql,
            parameterKinds: query.values.map((v) =>
              v instanceof Date ? "UTC-encoded-date" : typeof v,
            ),
            plan,
            actualPlan,
            returned: rows.length,
            elapsedMs,
          });
        }
      }
      // Narrow date first pages contain actual matches; combined deep pages may legitimately be empty.
      expect(
        cases.find((row) => row.combination === 1 && row.depth === "first")!
          .returned,
      ).toBeGreaterThan(0);
      mkdirSync(".cache/phase8a1", { recursive: true });
      writeFileSync(
        ".cache/phase8a1/explain-results.json",
        JSON.stringify(
          {
            syntheticMedia: 10000,
            familyMembers: 5,
            baselineMs,
            baselineReturned: baseline.length,
            cases,
            rowsExaminedMetric:
              "EXPLAIN ANALYZE operator actual rows/loops retained; no session-wide rows_examined counter",
            existingTimeoutComparisonMs: 10000,
            newIndexes: false,
          },
          null,
          2,
        ),
      );
    } finally {
      c.release();
    }
  }, 60000);
});

type Query = (
  sql: string,
  values?: unknown[],
) => Promise<[ResultSetHeader, unknown]>;

async function insertUser(connection: { query: Query }, username: string) {
  const [user] = await connection.query(
    `INSERT INTO users
      (username, username_normalized, password_hash, display_name, password_changed_at)
     VALUES (?,?,?,?,CURRENT_TIMESTAMP(3))`,
    [username, Buffer.from(username), "synthetic-not-used", "Phase 5A"],
  );
  return String(user.insertId);
}

async function insertMember(
  connection: { query: Query },
  familyId: string,
  userId: string,
) {
  const [member] = await connection.query(
    "INSERT INTO family_members (family_id, user_id, role) VALUES (?,?,'MEMBER')",
    [familyId, userId],
  );
  return String(member.insertId);
}

async function insertSession(
  connection: { query: Query },
  userId: string,
  tokenHash: Buffer,
) {
  const [session] = await connection.query(
    `INSERT INTO sessions
      (user_id, token_hash, client_type, authenticated_at, last_seen_at, expires_at)
     VALUES (?, ?, 'WEB', CURRENT_TIMESTAMP(3), CURRENT_TIMESTAMP(3),
             DATE_ADD(CURRENT_TIMESTAMP(3), INTERVAL 1 DAY))`,
    [userId, tokenHash],
  );
  return String(session.insertId);
}

async function insertAlbum(
  connection: { query: Query },
  familyId: string,
  ownerMemberId: string,
  name: string,
) {
  const [album] = await connection.query(
    `INSERT INTO albums (family_id, owner_member_id, name, visibility)
     VALUES (?,?,?,'CUSTOM')`,
    [familyId, ownerMemberId, name],
  );
  return String(album.insertId);
}

async function insertMedia(
  connection: { query: Query },
  familyId: string,
  memberId: string,
  at: string,
  extra?: {
    width: number;
    height: number;
    latitude: string;
    longitude: string;
  },
) {
  const sha = randomBytes(32);
  const [object] = await connection.query(
    `INSERT INTO storage_objects
      (family_id, sha256, byte_size, key_version, state, durable_at, verified_at)
     VALUES (?,?,8,1,'AVAILABLE',CURRENT_TIMESTAMP(3),CURRENT_TIMESTAMP(3))`,
    [familyId, sha],
  );
  const [upload] = await connection.query(
    `INSERT INTO upload_sessions
      (public_id, family_id, created_by_member_id, original_filename,
       declared_size, committed_offset, state, computed_sha256,
       finalize_started_at, storage_object_id, completed_at, expires_at)
     VALUES (?,?,?,'synthetic.png',8,8,'COMPLETE',?,
       CURRENT_TIMESTAMP(3),?,CURRENT_TIMESTAMP(3),
       DATE_ADD(CURRENT_TIMESTAMP(3), INTERVAL 1 DAY))`,
    [randomBytes(16), familyId, memberId, sha, String(object.insertId)],
  );
  const [media] = await connection.query(
    `INSERT INTO media_items
      (family_id, storage_object_id, source_upload_id, uploaded_at, timeline_key,
       display_width, display_height, gps_latitude, gps_longitude)
     VALUES (?,?,?,?,?,?,?,?,?)`,
    [
      familyId,
      String(object.insertId),
      String(upload.insertId),
      at,
      at,
      extra?.width ?? null,
      extra?.height ?? null,
      extra?.latitude ?? null,
      extra?.longitude ?? null,
    ],
  );
  return String(media.insertId);
}
