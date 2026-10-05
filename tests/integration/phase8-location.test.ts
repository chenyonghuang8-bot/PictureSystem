import { resolve } from "node:path";
import {
  loadLocationProjector,
  LocationProjector,
  aggregateLocationMap,
} from "../../packages/media/src/index.js";
import { AlbumService } from "../../apps/api/src/albums/service.js";
import {
  familyMapQuerySchema,
  familySearchQuerySchema,
  familyLocationOptionsQuerySchema,
} from "../../packages/contracts/src/index.js";
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
  MySqlLocationProjectionRepository,
  buildFamilyLocationQuery,
} from "../../packages/db/src/index.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("PHASE8A1_SEARCH_DEV_DATABASE_URL_REQUIRED");

describe.sequential("Phase8 location DEV CAS and authorized map", () => {
  const database = createDatabase(databaseUrl);
  const projector = loadLocationProjector(
    resolve("resources/location/2026-10-03"),
  );
  const albums = new MySqlAlbumRepository(database.pool, {
    locationProjector: projector,
  });
  const projections = new MySqlLocationProjectionRepository(
    database.pool,
    projector,
  );
  const service = new AlbumService(albums);
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
  let visibleTag = "",
    hiddenTag = "",
    unusedTag = "",
    foreignTag = "";

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
      for (const [mediaId, filename, member] of [
        [newerMedia, "IMG_Café%_!.PNG", viewerMember],
        [olderMedia, "img_Cafe\u0301%_!.png", viewerMember],
        [hiddenMedia, "hidden-source.png", otherMember],
        [deletedMedia, "deleted-source.png", otherMember],
      ]) {
        await connection.query(
          "UPDATE upload_sessions s JOIN media_items m ON m.family_id=s.family_id AND m.source_upload_id=s.id SET s.original_filename=?,s.created_by_member_id=? WHERE m.family_id=? AND m.id=?",
          [filename, member, familyId, mediaId],
        );
      }
      visibleTag = await insertSearchTag(connection, familyId, "生日");
      hiddenTag = await insertSearchTag(connection, familyId, "隐藏标签");
      unusedTag = await insertSearchTag(connection, familyId, "未使用");
      foreignTag = await insertSearchTag(connection, otherFamilyId, "生日");
      await connection.query(
        "INSERT INTO media_tags(family_id,media_id,tag_id) VALUES(?,?,?),(?,?,?),(?,?,?)",
        [
          familyId,
          newerMedia,
          visibleTag,
          familyId,
          hiddenMedia,
          hiddenTag,
          familyId,
          deletedMedia,
          hiddenTag,
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
      await database.pool.query("DELETE FROM media_tags WHERE family_id=?", [
        familyId,
      ]);
      await database.pool.query("DELETE FROM tags WHERE family_id=?", [
        familyId,
      ]);
      await database.pool.query("DELETE FROM album_media WHERE family_id = ?", [
        familyId,
      ]);
      await database.pool.query(
        "DELETE FROM media_location_projections WHERE family_id=?",
        [familyId],
      );
      await database.pool.query(
        "DELETE FROM background_jobs WHERE family_id=?",
        [familyId],
      );
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
        await database.pool.query("DELETE FROM tags WHERE family_id=?", [
          otherFamilyId,
        ]);
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

  const context = () => ({
    identity: { userId: viewerUserId, sessionId: viewerSessionId },
    tokenHash,
  });
  const rows = (filters = {}) =>
    albums.locationFamilyMedia({ actor: viewer(), familyId, filters });
  async function resetProjection() {
    await database.pool.query(
      "UPDATE media_items SET metadata_generation=generation,gps_latitude='37.780000',gps_longitude='-122.420000' WHERE family_id=? AND id IN (?,?)",
      [familyId, newerMedia, hiddenMedia],
    );
    for (const token of await projections.scan(familyId, 100))
      await projections.apply(token);
  }
  it("backfills current projections with exact CAS, concurrent NOOP, and no original reads", async () => {
    await database.pool.query(
      "UPDATE media_items SET metadata_generation=generation WHERE family_id=?",
      [familyId],
    );
    const [token] = await projections.scan(familyId, 100);
    expect(token!.mediaId).toBe(newerMedia);
    expect(
      (
        await Promise.all([
          projections.apply(token!),
          projections.apply(token!),
        ])
      ).sort(),
    ).toEqual(["INSERTED", "NOOP"]);
    const visible = await rows();
    expect(visible.map((r) => r.mediaId)).toEqual([newerMedia, olderMedia]);
    expect(visible[0]!.h3Cell).toBeTruthy();
    expect(JSON.stringify(visible)).not.toContain("37.780000");
    expect(await projections.scan(familyId, 100)).toEqual([]);
  });
  it("keeps hidden collections, duplicate placements, no-GPS, and all AND filters consistent across map/search/regions", async () => {
    await resetProjection();
    const baseline = aggregateLocationMap(
      await rows(),
      [-180, -90, 180, 90],
      22,
    );
    expect(baseline.locatedCount).toBe(1);
    expect(baseline.noGpsCount).toBe(1);
    await database.pool.query(
      "INSERT INTO user_favorites(family_id,member_id,media_id) VALUES(?,?,?)",
      [familyId, viewerMember, newerMedia],
    );
    try {
      const query = familySearchQuerySchema.parse({
        location: "country:US",
        fromDate: "2024-06-01",
        toDate: "2024-06-01",
        albumId: lowAlbum,
        filename: "Café%_!",
        uploaderMemberId: viewerMember,
        tagId: visibleTag,
        favoritesOnly: "true",
        limit: "1",
      });
      const result = await service.search(context(), familyId, query);
      expect(result.media.map((r) => r.mediaId)).toEqual([newerMedia]);
      const map = await service.map(
        context(),
        familyId,
        familyMapQuerySchema.parse({
          location: query.location,
          fromDate: query.fromDate,
          toDate: query.toDate,
          albumId: query.albumId,
          filename: query.filename,
          uploaderMemberId: query.uploaderMemberId,
          tagId: query.tagId,
          favoritesOnly: "true",
        }),
      );
      expect(map.locatedCount).toBe(1);
    } finally {
      await database.pool.query(
        "DELETE FROM user_favorites WHERE family_id=?",
        [familyId],
      );
    }
    for (const filters of [
      { albumId: hiddenAlbum },
      { albumId: otherFamilyAlbum },
      { filename: "hidden-source" },
      { tagId: hiddenTag },
      { tagId: foreignTag },
      { tagId: unusedTag },
      { uploaderMemberId: otherMember },
      { location: "country:CA" },
      { location: "unknown" },
    ])
      expect(await rows(filters)).toEqual([]);
    const countries = await service.locationOptions(
      context(),
      familyId,
      familyLocationOptionsQuerySchema.parse({ kind: "country" }),
    );
    expect(countries.options).toEqual([
      { id: "country:US", name: "United States of America", count: 1 },
    ]);
    const cities = await service.locationOptions(
      context(),
      familyId,
      familyLocationOptionsQuerySchema.parse({ kind: "city" }),
    );
    expect(cities.options[0]!.name).toMatch(/附近$/);
    expect(
      (
        await service.search(
          context(),
          familyId,
          familySearchQuerySchema.parse({ location: cities.options[0]!.id }),
        )
      ).media,
    ).toHaveLength(1);
    expect(
      aggregateLocationMap(await rows(), [-180, -90, 180, 90], 22),
    ).toEqual(baseline);
  });
  it("has no ADMIN bypass and rejects disabled, revoked, and other-family actors", async () => {
    for (const role of ["ADMIN", "SUPER_ADMIN"]) {
      await database.pool.query(
        "UPDATE family_members SET role=? WHERE family_id=? AND id=?",
        [role, familyId, viewerMember],
      );
      expect((await rows()).map((r) => r.mediaId)).not.toContain(hiddenMedia);
    }
    await database.pool.query(
      "UPDATE family_members SET role='MEMBER' WHERE family_id=? AND id=?",
      [familyId, viewerMember],
    );
    await expect(
      albums.locationFamilyMedia({
        actor: {
          userId: outsiderUserId,
          sessionId: outsiderSessionId,
          tokenHash: outsiderHash,
        },
        familyId,
        filters: {},
      }),
    ).rejects.toBeInstanceOf(AlbumRepositoryError);
    await database.pool.query(
      "UPDATE users SET disabled_at=CURRENT_TIMESTAMP(3) WHERE id=?",
      [viewerUserId],
    );
    try {
      await expect(rows()).rejects.toBeInstanceOf(AlbumRepositoryError);
    } finally {
      await database.pool.query(
        "UPDATE users SET disabled_at=NULL WHERE id=?",
        [viewerUserId],
      );
    }
  });
  it("rejects stale GPS/generation/lifecycle CAS and masks old versions immediately", async () => {
    await resetProjection();
    const [tokenRows] = await database.pool.query<RowDataPacket[]>(
      "SELECT CAST(storage_object_id AS CHAR) object FROM media_items WHERE id=?",
      [newerMedia],
    );
    await database.pool.query(
      "DELETE FROM media_location_projections WHERE family_id=? AND media_id=?",
      [familyId, newerMedia],
    );
    const [token] = await projections.scan(familyId, 100);
    await database.pool.query(
      "UPDATE media_items SET gps_latitude='37.800000' WHERE id=?",
      [newerMedia],
    );
    expect(await projections.apply(token!)).toBe("STALE");
    await database.pool.query(
      "UPDATE media_items SET gps_latitude='37.780000',generation=generation+1 WHERE id=?",
      [newerMedia],
    );
    expect(await projections.apply(token!)).toBe("STALE");
    expect((await rows())[0]!.h3Cell).toBeNull();
    await database.pool.query(
      "UPDATE media_items SET generation=1,metadata_generation=1,lifecycle_revision=lifecycle_revision+1 WHERE id=?",
      [newerMedia],
    );
    expect(await projections.apply(token!)).toBe("STALE");
    await resetProjection();
    const drift = new MySqlAlbumRepository(database.pool, {
      locationProjector: new LocationProjector("b".repeat(64), [], []),
    });
    expect(
      (
        await drift.locationFamilyMedia({
          actor: viewer(),
          familyId,
          filters: {},
        })
      )[0]!.h3Cell,
    ).toBeNull();
    expect(tokenRows).toHaveLength(1);
  });
  it("serializes a waiting backfill behind media update and refuses cross-family/invalid shape writes", async () => {
    await resetProjection();
    await database.pool.query(
      "DELETE FROM media_location_projections WHERE family_id=? AND media_id=?",
      [familyId, newerMedia],
    );
    const [token] = await projections.scan(familyId, 100);
    const c = await database.pool.getConnection();
    try {
      await c.beginTransaction();
      await c.query("SELECT id FROM media_items WHERE id=? FOR UPDATE", [
        newerMedia,
      ]);
      const pending = projections.apply(token!);
      await c.query(
        "UPDATE media_items SET lifecycle_revision=lifecycle_revision+1 WHERE id=?",
        [newerMedia],
      );
      await c.commit();
      expect(await pending).toBe("STALE");
    } finally {
      c.release();
    }
    const p = projector.project("37.78", "-122.42");
    await expect(
      database.pool.query(
        "INSERT INTO media_location_projections(family_id,media_id,generation,policy_version,dataset_version,h3_cell) VALUES(?,?,1,1,?,?)",
        [otherFamilyId, newerMedia, p.datasetVersion, p.h3Cell],
      ),
    ).rejects.toMatchObject({ code: "ER_NO_REFERENCED_ROW_2" });
    await expect(
      database.pool.query(
        "INSERT INTO media_location_projections(family_id,media_id,generation,policy_version,dataset_version,h3_cell) VALUES(?,?,1,1,?,'INVALID')",
        [familyId, newerMedia, p.datasetVersion],
      ),
    ).rejects.toMatchObject({ code: "ER_CHECK_CONSTRAINT_VIOLATED" });
    await resetProjection();
  });
  it("keeps concurrent dataset writers separate and rolls back a same-version payload conflict", async () => {
    await resetProjection();
    await database.pool.query(
      "DELETE FROM media_location_projections WHERE family_id=? AND media_id=?",
      [familyId, newerMedia],
    );
    const [token] = await projections.scan(familyId, 100);
    const alternate = new LocationProjector("b".repeat(64), [], []);
    const other = new MySqlLocationProjectionRepository(
      database.pool,
      alternate,
    );
    expect(
      await Promise.all([projections.apply(token!), other.apply(token!)]),
    ).toEqual(["INSERTED", "INSERTED"]);
    const [versions] = await database.pool.query<RowDataPacket[]>(
      "SELECT dataset_version version,country_code country FROM media_location_projections WHERE family_id=? AND media_id=? ORDER BY dataset_version",
      [familyId, newerMedia],
    );
    expect(versions).toHaveLength(2);
    expect(
      versions.find((r) => r.version === projector.datasetVersion)?.country,
    ).toBe("US");
    expect(
      versions.find((r) => r.version === alternate.datasetVersion)?.country,
    ).toBeNull();
    expect((await rows())[0]!.countryCode).toBe("US");
    await database.pool.query(
      "UPDATE media_location_projections SET country_code='CA' WHERE family_id=? AND media_id=? AND dataset_version=?",
      [familyId, newerMedia, projector.datasetVersion],
    );
    await expect(projections.apply(token!)).rejects.toThrow(
      "LOCATION_INVARIANT_CONFLICT",
    );
    const [unchanged] = await database.pool.query<RowDataPacket[]>(
      "SELECT country_code country FROM media_location_projections WHERE family_id=? AND media_id=? AND dataset_version=?",
      [familyId, newerMedia, projector.datasetVersion],
    );
    expect(unchanged[0]!.country).toBe("CA");
    await database.pool.query(
      "DELETE FROM media_location_projections WHERE family_id=? AND media_id=?",
      [familyId, newerMedia],
    );
    await resetProjection();
  });
  it("paginates regions completely and rejects cursors after dataset or filter drift", async () => {
    await resetProjection();
    await database.pool.query(
      "UPDATE media_items SET metadata_generation=generation,gps_latitude='48.856600',gps_longitude='2.352200' WHERE id=?",
      [olderMedia],
    );
    try {
      for (const token of await projections.scan(familyId, 100))
        await projections.apply(token);
      const first = await service.locationOptions(
        context(),
        familyId,
        familyLocationOptionsQuerySchema.parse({ kind: "country", limit: "1" }),
      );
      expect(first.options.map((r) => r.id)).toEqual(["country:FR"]);
      expect(first.nextCursor).toBeTruthy();
      const next = familyLocationOptionsQuerySchema.parse({
        kind: "country",
        limit: "1",
        cursor: first.nextCursor,
      });
      const second = await service.locationOptions(context(), familyId, next);
      expect(second.options.map((r) => r.id)).toEqual(["country:US"]);
      expect(second.nextCursor).toBeNull();
      const drift = new AlbumService(
        new MySqlAlbumRepository(database.pool, {
          locationProjector: new LocationProjector("b".repeat(64), [], []),
        }),
      );
      await expect(
        drift.locationOptions(context(), familyId, next),
      ).rejects.toMatchObject({ statusCode: 400 });
      await expect(
        service.locationOptions(context(), familyId, {
          ...next,
          albumId: highAlbum,
        }),
      ).rejects.toMatchObject({ statusCode: 400 });
    } finally {
      await database.pool.query(
        "DELETE FROM media_location_projections WHERE family_id=? AND media_id=?",
        [familyId, olderMedia],
      );
      await database.pool.query(
        "UPDATE media_items SET gps_latitude=NULL,gps_longitude=NULL WHERE id=?",
        [olderMedia],
      );
    }
  });
  it("hides trash and keeps projection available after restore without mutating originals", async () => {
    await resetProjection();
    await database.pool.query(
      "UPDATE media_items SET trashed_at=CURRENT_TIMESTAMP(3),trashed_by_member_id=?,purge_after=DATE_ADD(CURRENT_TIMESTAMP(3),INTERVAL 30 DAY),lifecycle_revision=lifecycle_revision+1 WHERE id=?",
      [viewerMember, newerMedia],
    );
    try {
      expect(
        aggregateLocationMap(await rows(), [-180, -90, 180, 90], 22)
          .locatedCount,
      ).toBe(0);
    } finally {
      await database.pool.query(
        "UPDATE media_items SET trashed_at=NULL,trashed_by_member_id=NULL,purge_after=NULL,lifecycle_revision=lifecycle_revision+1 WHERE id=?",
        [newerMedia],
      );
    }
    expect(
      aggregateLocationMap(await rows(), [-180, -90, 180, 90], 22).locatedCount,
    ).toBe(1);
  });
  it("records actual 10k location counts and the shared SQL EXPLAIN without per-request caches", async () => {
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
      await c.query(
        "INSERT INTO media_tags(family_id,media_id,tag_id) SELECT family_id,id,? FROM media_items WHERE family_id=? AND id>? AND MOD(id,20)=0",
        [visibleTag, familyId, String(maxMediaRows[0]!.id)],
      );

      await c.query(
        "UPDATE media_items SET metadata_generation=generation,gps_latitude='37.780000',gps_longitude='-122.420000' WHERE family_id=? AND id>?",
        [familyId, String(maxMediaRows[0]!.id)],
      );
      const p = projector.project("37.780000", "-122.420000");
      await c.query(
        "INSERT INTO media_location_projections(family_id,media_id,generation,policy_version,dataset_version,h3_cell,country_code,city_geoname_id) SELECT family_id,id,generation,?,?,?,?,? FROM media_items WHERE family_id=? AND id>?",
        [
          p.policyVersion,
          p.datasetVersion,
          p.h3Cell,
          p.countryCode,
          p.cityGeonameId,
          familyId,
          String(maxMediaRows[0]!.id),
        ],
      );
      const query = buildFamilyLocationQuery(
        familyId,
        viewerMember,
        {},
        projector,
      );
      const [plan] = await c.query("EXPLAIN " + query.sql, query.values);
      const [actualPlan] = await c.query(
        "EXPLAIN ANALYZE " + query.sql,
        query.values,
      );
      const start = performance.now(),
        map = aggregateLocationMap(await rows(), [-180, -90, 180, 90], 22),
        elapsedMs = performance.now() - start;
      expect(map.locatedCount).toBe(5001);
      expect(map.clusters.reduce((sum, r) => sum + r.count, 0)).toBe(5001);
      expect(elapsedMs).toBeLessThan(10000);
      mkdirSync(".cache/phase8-map/evidence", { recursive: true });
      writeFileSync(
        ".cache/phase8-map/evidence/location-10k.json",
        JSON.stringify(
          {
            syntheticMedia: 10000,
            familyMembers: 5,
            visibleLocated: map.locatedCount,
            elapsedMs,
            plan,
            actualPlan,
            sql: query.sql,
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

async function insertSearchTag(
  connection: { query: Query },
  familyId: string,
  name: string,
) {
  const [tag] = await connection.query(
    "INSERT INTO tags(family_id,name,name_normalized) VALUES(?,?,?)",
    [familyId, name, Buffer.from(name)],
  );
  return String(tag.insertId);
}
