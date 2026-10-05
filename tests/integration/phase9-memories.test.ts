import { beforeAll, afterAll, describe, it, expect } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { performance } from "node:perf_hooks";
import {
  createDatabase,
  MySqlAlbumRepository,
  buildFamilyMemoriesQuery,
  MemoriesAnchorExpiredError,
} from "../../packages/db/dist/index.js";
import {
  memoriesCalendar,
  memoriesQuerySchema,
  type MemoriesKind,
} from "../../packages/contracts/src/index.js";
import {
  AlbumService,
  decodeMemoriesCursor,
  encodeMemoriesCursor,
} from "../../apps/api/src/albums/service.js";
import { MemoriesFixture } from "../fixtures/memories-db.js";
import type { RowDataPacket } from "../../packages/db/src/index.js";
if (!process.env.DATABASE_URL)
  throw new Error("MEMORIES_DEV_DATABASE_REQUIRED");
describe.sequential("Phase9 current authorized displayable memories", () => {
  const db = createDatabase(process.env.DATABASE_URL!);
  const f = new MemoriesFixture(db.pool);
  let instant = new Date("2026-10-05T04:00:00Z");
  const repo = new MySqlAlbumRepository(db.pool, {
    memoriesClock: () => instant,
  });
  const service = new AlbumService(repo);
  const context = () =>
    ({
      identity: { userId: f.users[0]!, sessionId: f.sessionId },
      tokenHash: f.tokenHash,
    }) as Parameters<AlbumService["memories"]>[0];
  let base = "",
    fallback = "";
  const page = (
    kind: MemoriesKind = "ON_THIS_DAY",
    limit = 48,
    cursor?: string,
  ) =>
    service.memories(context(), f.familyId, {
      kind,
      limit,
      ...(cursor ? { cursor } : {}),
    });
  beforeAll(async () => {
    await f.setup();
    base = await f.media();
    fallback = await f.media("2025-10-04 23:30:00.000", false);
    await db.pool.query(
      "INSERT INTO album_media(family_id,album_id,media_id) VALUES(?,?,?),(?,?,?)",
      [f.familyId, f.highAlbum, base, f.familyId, f.hiddenAlbum, base],
    );
  });
  afterAll(async () => {
    try {
      await f.cleanup();
    } finally {
      await db.pool.end();
    }
  });
  it("uses literal unknown-offset wall date, canonical UTC fallback and minimum visible album, preview/page equivalent", async () => {
    const today = await page();
    expect(today.media.map((x) => x.mediaId)).toEqual([base]);
    expect(today.media[0]?.albumId).toBe(f.lowAlbum);
    expect(today.media[0]?.timelineDate).toBe("2025-10-05");
    expect(today.media[0]?.dateBasis).toBe("CAPTURE_LOCAL");
    const week = await page("LAST_YEAR_WEEK");
    expect(week.media.find((x) => x.mediaId === fallback)).toMatchObject({
      timelineDate: "2025-10-04",
      dateBasis: "UPLOAD_UTC",
    });
    const preview = await service.memoriesPreview(context(), f.familyId);
    expect(preview.context).toEqual(today.context);
    expect(preview.cards[0].media).toEqual(today.media.slice(0, 6));
    expect(preview.cards[1].media).toEqual(week.media.slice(0, 6));
    const [before] = await db.pool.query<RowDataPacket[]>(
      "SELECT source_upload_id,uploaded_at FROM media_items WHERE id=?",
      [base],
    );
    await db.pool.query(
      "INSERT INTO upload_sessions(public_id,family_id,created_by_member_id,original_filename,declared_size,committed_offset,state,computed_sha256,storage_object_id,finalize_started_at,completed_at,expires_at) SELECT RANDOM_BYTES(16),family_id,created_by_member_id,'reupload.jpg',declared_size,committed_offset,state,computed_sha256,storage_object_id,CURRENT_TIMESTAMP(3),CURRENT_TIMESTAMP(3),expires_at FROM upload_sessions WHERE id=?",
      [before[0]!.source_upload_id],
    );
    const [after] = await db.pool.query<RowDataPacket[]>(
      "SELECT source_upload_id,uploaded_at FROM media_items WHERE id=?",
      [base],
    );
    expect(after).toEqual(before);
  });
  it("hidden-only media cannot alter preview/hasMore, even for ADMIN/SUPER_ADMIN; FAMILY and explicit grant work", async () => {
    const before = await service.memoriesPreview(context(), f.familyId);
    const hidden = await f.media(undefined, true, f.hiddenAlbum);
    for (const role of ["MEMBER", "ADMIN", "SUPER_ADMIN"]) {
      await db.pool.query("UPDATE family_members SET role=? WHERE id=?", [
        role,
        f.memberId,
      ]);
      expect(await service.memoriesPreview(context(), f.familyId)).toEqual(
        before,
      );
    }
    await db.pool.query("UPDATE family_members SET role='MEMBER' WHERE id=?", [
      f.memberId,
    ]);
    await db.pool.query("UPDATE albums SET visibility='FAMILY' WHERE id=?", [
      f.hiddenAlbum,
    ]);
    expect((await page()).media.some((x) => x.mediaId === hidden)).toBe(true);
    await db.pool.query("UPDATE albums SET visibility='CUSTOM' WHERE id=?", [
      f.hiddenAlbum,
    ]);
    await db.pool.query(
      "INSERT INTO album_members(family_id,album_id,member_id,can_view) VALUES(?,?,?,1)",
      [f.familyId, f.hiddenAlbum, f.memberId],
    );
    expect((await page()).media.some((x) => x.mediaId === hidden)).toBe(true);
    await db.pool.query("DELETE FROM album_members WHERE family_id=?", [
      f.familyId,
    ]);
    expect((await page()).media.some((x) => x.mediaId === hidden)).toBe(false);
  });
  it("filters all processing states, videos, stale metadata/recipe/assets, absent preview/thumbnail, unavailable storage, trash and deleted placement", async () => {
    const candidates: string[] = [];
    for (const state of [
      "PENDING",
      "PROCESSING",
      "PARTIAL",
      "FAILED",
      "BLOCKED",
    ]) {
      const id = await f.media();
      candidates.push(id);
      await db.pool.query(
        "UPDATE media_items SET processing_state=?,last_failure_code=IF(? IN ('FAILED','BLOCKED'),'MALFORMED_MEDIA',NULL) WHERE id=?",
        [state, state, id],
      );
    }
    for (const patch of [
      "media_type='VIDEO'",
      "recipe_id=2",
      `trashed_at=CURRENT_TIMESTAMP(3),trashed_by_member_id=${f.memberId},purge_after=DATE_ADD(CURRENT_TIMESTAMP(3),INTERVAL 30 DAY)`,
    ]) {
      const id = await f.media();
      candidates.push(id);
      await db.pool.query(`UPDATE media_items SET ${patch} WHERE id=?`, [id]);
    }
    const stale = await f.media();
    candidates.push(stale);
    await db.pool.query(
      "UPDATE derived_assets SET generation=2 WHERE media_id=?",
      [stale],
    );
    for (const kind of ["PREVIEW", "THUMBNAIL"]) {
      const id = await f.media();
      candidates.push(id);
      await db.pool.query(
        "DELETE FROM derived_assets WHERE media_id=? AND kind=?",
        [id, kind],
      );
    }
    for (const [kind, patch] of [
      ["PREVIEW", "width=2561"],
      ["THUMBNAIL", "height=481"],
      ["PREVIEW", "state='PUBLISHING',published_at=NULL"],
    ]) {
      const id = await f.media();
      candidates.push(id);
      await db.pool.query(
        `UPDATE derived_assets SET ${patch} WHERE media_id=? AND kind=?`,
        [id, kind],
      );
    }
    const constrained = await f.media();
    await expect(
      db.pool.query(
        "UPDATE derived_assets SET reserved_bytes=524289 WHERE media_id=? AND kind='THUMBNAIL'",
        [constrained],
      ),
    ).rejects.toMatchObject({ code: "ER_CHECK_CONSTRAINT_VIOLATED" });
    await expect(
      db.pool.query("UPDATE media_items SET metadata_generation=2 WHERE id=?", [
        constrained,
      ]),
    ).rejects.toMatchObject({ code: "ER_CHECK_CONSTRAINT_VIOLATED" });
    const incoherent = await f.media();
    candidates.push(incoherent);
    await db.pool.query(
      "UPDATE upload_sessions s JOIN media_items m ON m.source_upload_id=s.id SET s.computed_sha256=RANDOM_BYTES(32) WHERE m.id=?",
      [incoherent],
    );
    const purging = await f.media();
    candidates.push(purging);
    await db.pool.query(
      "UPDATE media_items SET trashed_at=CURRENT_TIMESTAMP(3),trashed_by_member_id=?,purge_after=DATE_ADD(CURRENT_TIMESTAMP(3),INTERVAL 30 DAY) WHERE id=?",
      [f.memberId, purging],
    );
    const intent = await f.insert(
      "INSERT INTO purge_intents(family_id,operation_id,media_id,storage_object_id,source_upload_id,lifecycle_revision,trashed_at,purge_after,request_source,actor_member_id,original_bytes,available_at) SELECT family_id,UUID(),id,storage_object_id,source_upload_id,lifecycle_revision,trashed_at,purge_after,'MANUAL',?,8,CURRENT_TIMESTAMP(3) FROM media_items WHERE id=?",
      [f.memberId, purging],
    );
    await db.pool.query("UPDATE media_items SET purge_intent_id=? WHERE id=?", [
      intent,
      purging,
    ]);
    const unavailable = await f.media();
    candidates.push(unavailable);
    await db.pool.query(
      "UPDATE storage_objects s JOIN media_items m ON m.storage_object_id=s.id SET s.state='MISSING' WHERE m.id=?",
      [unavailable],
    );
    const deleted = await f.album(f.memberId, "Deleted");
    candidates.push(await f.media(undefined, true, deleted));
    await db.pool.query(
      "UPDATE albums SET deleted_at=CURRENT_TIMESTAMP(3) WHERE id=?",
      [deleted],
    );
    const result = await page();
    for (const id of candidates)
      expect(result.media.map((x) => x.mediaId)).not.toContain(id);
  });
  it("equal-key pagination is unique, limit+1 uses last emitted item, permission revoked between pages excludes newly hidden rows", async () => {
    for (let i = 0; i < 7; i++) await f.media();
    const ids: string[] = [];
    let cursor: string | undefined;
    do {
      const result = await page("ON_THIS_DAY", 2, cursor);
      expect(result.media.length).toBeLessThanOrEqual(2);
      ids.push(...result.media.map((x) => x.mediaId));
      cursor = result.nextCursor ?? undefined;
    } while (cursor);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toContain(base);
    const first = await page("ON_THIS_DAY", 2);
    const cursorToken = decodeMemoriesCursor(
      first.nextCursor!,
      f.users[0]!,
      f.familyId,
      { kind: "ON_THIS_DAY", limit: 2 },
    );
    expect(cursorToken.mediaId).toBe(first.media.at(-1)!.mediaId);
    await db.pool.query(
      "UPDATE albums SET deleted_at=CURRENT_TIMESTAMP(3) WHERE id IN (?,?)",
      [f.lowAlbum, f.highAlbum],
    );
    expect((await page("ON_THIS_DAY", 2, first.nextCursor!)).media).toEqual([]);
    await db.pool.query("UPDATE albums SET deleted_at=NULL WHERE id IN (?,?)", [
      f.lowAlbum,
      f.highAlbum,
    ]);
  });
  it("current auth precedes expired-anchor 409 and every continuation rechecks user/member/session", async () => {
    const first = await page("ON_THIS_DAY", 2);
    for (const anchor of ["2020-10-05", "2030-10-05"]) {
      const edited = encodeMemoriesCursor(
        first.media[0]!,
        f.users[0]!,
        f.familyId,
        { kind: "ON_THIS_DAY", limit: 2 },
        anchor,
      );
      await expect(page("ON_THIS_DAY", 2, edited)).rejects.toMatchObject({
        statusCode: 409,
        code: "MEMORIES_ANCHOR_EXPIRED",
      });
    }
    instant = new Date("2026-10-06T04:00:00Z");
    await expect(
      page("ON_THIS_DAY", 2, first.nextCursor!),
    ).rejects.toMatchObject({
      statusCode: 409,
      code: "MEMORIES_ANCHOR_EXPIRED",
    });
    for (const [table, id, column] of [
      ["users", f.users[0]!, "disabled_at"],
      ["family_members", f.memberId, "disabled_at"],
      ["sessions", f.sessionId, "revoked_at"],
    ]) {
      await db.pool.query(
        `UPDATE ${table} SET ${column}=CURRENT_TIMESTAMP(3)${table === "sessions" ? ",revoke_reason='LOGOUT'" : ""} WHERE id=?`,
        [id],
      );
      await expect(
        page("ON_THIS_DAY", 2, first.nextCursor!),
      ).rejects.toMatchObject({ statusCode: 401 });
      await db.pool.query(
        `UPDATE ${table} SET ${column}=NULL${table === "sessions" ? ",revoke_reason=NULL" : ""} WHERE id=?`,
        [id],
      );
    }
    instant = new Date("2026-10-05T04:00:00Z");
    expect(MemoriesAnchorExpiredError).toBeDefined();
  });
  it("actual date predicates cover leap-day exact matching and half-open cross-year week", async () => {
    const leap = await f.media("2024-02-29 12:00:00.000"),
      ordinary = await f.media("2024-02-28 12:00:00.000");
    instant = new Date("2028-02-29T04:00:00Z");
    expect((await page()).media.map((x) => x.mediaId)).toEqual([leap]);
    instant = new Date("2025-02-28T04:00:00Z");
    const day = (await page()).media.map((x) => x.mediaId);
    expect(day).toContain(ordinary);
    expect(day).not.toContain(leap);
    const start = await f.media("2024-12-30 00:00:00.000"),
      end = await f.media("2025-01-06 00:00:00.000");
    instant = new Date("2026-01-01T04:00:00Z");
    const week = (await page("LAST_YEAR_WEEK")).media.map((x) => x.mediaId);
    expect(week).toContain(start);
    expect(week).not.toContain(end);
    instant = new Date("2026-10-05T04:00:00Z");
  });
  it("records owned 10k SQL plans and bounded first/deep page performance without new indexes", async () => {
    const digits =
      "(SELECT 0 n UNION ALL SELECT 1 UNION ALL SELECT 2 UNION ALL SELECT 3 UNION ALL SELECT 4 UNION ALL SELECT 5 UNION ALL SELECT 6 UNION ALL SELECT 7 UNION ALL SELECT 8 UNION ALL SELECT 9)";
    const sequence = `(SELECT a.n+10*b.n+100*c.n+1000*d.n n FROM ${digits} a CROSS JOIN ${digits} b CROSS JOIN ${digits} c CROSS JOIN ${digits} d)`;
    const [existing] = await db.pool.query<RowDataPacket[]>(
      "SELECT COALESCE(MAX(id),0) id FROM storage_objects WHERE family_id=?",
      [f.familyId],
    );
    const boundary = String(existing[0]!.id);
    await db.pool.query(
      `INSERT INTO storage_objects(family_id,sha256,byte_size,key_version,state,durable_at,verified_at) SELECT ?,UNHEX(SHA2(CONCAT(?,n),256)),8,1,'AVAILABLE',CURRENT_TIMESTAMP(3),CURRENT_TIMESTAMP(3) FROM ${sequence} numbers`,
      [f.familyId, f.suffix],
    );
    await db.pool.query(
      "INSERT INTO upload_sessions(public_id,family_id,created_by_member_id,original_filename,declared_size,committed_offset,state,computed_sha256,finalize_started_at,storage_object_id,completed_at,expires_at) SELECT UNHEX(SUBSTRING(SHA2(CONCAT(?,s.id),256),1,32)),s.family_id,?,'synthetic-perf.jpg',8,8,'COMPLETE',s.sha256,CURRENT_TIMESTAMP(3),s.id,CURRENT_TIMESTAMP(3),DATE_ADD(CURRENT_TIMESTAMP(3),INTERVAL 1 DAY) FROM storage_objects s WHERE s.family_id=? AND s.id>?",
      [f.suffix, f.memberId, f.familyId, boundary],
    );
    await db.pool.query(
      "INSERT INTO media_items(family_id,storage_object_id,source_upload_id,uploaded_at,timeline_key,media_type,processing_state,metadata_generation) SELECT family_id,storage_object_id,id,IF(MOD(id,3)=0,'2025-10-05','2025-10-04'),IF(MOD(id,3)=0,'2025-10-05','2025-10-04'),'IMAGE','READY',1 FROM upload_sessions WHERE family_id=? AND storage_object_id>?",
      [f.familyId, boundary],
    );
    await db.pool.query(
      "INSERT INTO background_jobs(family_id,media_id,generation,recipe_id,job_type,available_at) SELECT family_id,id,1,1,'IMAGE_DERIVATIVES',CURRENT_TIMESTAMP(3) FROM media_items WHERE family_id=? AND storage_object_id>?",
      [f.familyId, boundary],
    );
    for (const kind of ["PREVIEW", "THUMBNAIL"])
      await db.pool.query(
        "INSERT INTO derived_assets(family_id,media_id,generation,recipe_id,kind,state,reserved_bytes,byte_size,sha256,width,height,output_mime,producer_job_id,producer_lease_epoch,published_at) SELECT family_id,media_id,1,1,?,'READY',100,8,RANDOM_BYTES(32),1,1,'image/webp',id,1,CURRENT_TIMESTAMP(3) FROM background_jobs WHERE family_id=? AND media_id IN(SELECT id FROM media_items WHERE family_id=? AND storage_object_id>?)",
        [kind, f.familyId, f.familyId, boundary],
      );
    await db.pool.query(
      "INSERT INTO album_media(family_id,album_id,media_id) SELECT family_id,IF(MOD(id,2)=0,?,?),id FROM media_items WHERE family_id=? AND storage_object_id>?",
      [f.lowAlbum, f.hiddenAlbum, f.familyId, boundary],
    );
    const [count] = await db.pool.query<RowDataPacket[]>(
      "SELECT COUNT(*) n FROM media_items WHERE family_id=? AND storage_object_id>?",
      [f.familyId, boundary],
    );
    expect(Number(count[0]!.n)).toBe(10000);
    const evidence = [];
    for (const kind of ["ON_THIS_DAY", "LAST_YEAR_WEEK"] as const)
      for (const deep of [false, true]) {
        const seedQuery = buildFamilyMemoriesQuery(
          f.familyId,
          f.memberId,
          kind,
          memoriesCalendar(instant),
          501,
        );
        const [seedRows] = await db.pool.query<RowDataPacket[]>(
          seedQuery.sql,
          seedQuery.values,
        );
        const last = seedRows[500]!;
        expect(last).toBeDefined();
        const query = buildFamilyMemoriesQuery(
          f.familyId,
          f.memberId,
          kind,
          memoriesCalendar(instant),
          49,
          deep
            ? {
                timelineKey: new Date(last.timelineKey).toISOString(),
                mediaId: String(last.mediaId),
              }
            : undefined,
        );
        const [plan] = await db.pool.query(
          "EXPLAIN ANALYZE " + query.sql,
          query.values,
        );
        const start = performance.now();
        const [rows] = await db.pool.query<RowDataPacket[]>(
          query.sql,
          query.values,
        );
        const elapsedMs = performance.now() - start;
        expect(rows.length).toBeLessThanOrEqual(49);
        expect(rows.length).toBe(49);
        expect(elapsedMs).toBeLessThan(10000);
        evidence.push({ kind, deep, plan, elapsedMs, returned: rows.length });
      }
    mkdirSync(".cache/phase9", { recursive: true });
    writeFileSync(
      ".cache/phase9/explain-10k.json",
      JSON.stringify(
        { syntheticMedia: 10000, newIndexes: false, cases: evidence },
        null,
        2,
      ),
    );
    expect(memoriesQuerySchema.parse({ limit: "100" }).limit).toBe(100);
  }, 60000);
});
