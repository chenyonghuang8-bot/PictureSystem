import type { PoolConnection, RowDataPacket } from "mysql2/promise";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";
import {
  acquireCheckedConnection,
  createDatabase,
  assertMigrationReadiness,
  loadExpectedMigrationManifest,
} from "../../packages/db/src/index.js";
import { createPhase6SchemaFixture } from "../../packages/db/scripts/phase6-schema-fixture.js";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("PHASE6A_DEV_ENV_REQUIRED");
type Fixture = Awaited<ReturnType<typeof createPhase6SchemaFixture>>;

describe.sequential("Phase 6A live native FK/CHECK/unique/RESTRICT", () => {
  const database = createDatabase(url);
  let c: PoolConnection;
  let a: Fixture;
  let b: Fixture;
  let tagA: string;
  let tagB: string;
  beforeAll(async () => {
    const conn = await acquireCheckedConnection(database.pool);
    try {
      const [rows] = await conn.query<RowDataPacket[]>(
        "SELECT DATABASE() db,VERSION() version,CURRENT_USER() account",
      );
      expect(rows[0]?.db).toBe("family_album_dev");
      expect(rows[0]?.version).toBe("9.7.2");
      expect(String(rows[0]?.account).split("@")[0]?.toLowerCase()).not.toBe(
        "root",
      );
      const manifest = await loadExpectedMigrationManifest();
      expect(manifest[6]?.tag).toBe("0006_phase_06_album_features");
      expect((await assertMigrationReadiness(conn)).migrationCount).toBe(
        manifest.length,
      );
    } finally {
      conn.release();
    }
  });
  beforeEach(async () => {
    c = await acquireCheckedConnection(database.pool);
    await c.beginTransaction();
    a = await createPhase6SchemaFixture(c);
    b = await createPhase6SchemaFixture(c);
    tagA = await insertTag(a.familyId, "Trip", Buffer.from("trip"));
    tagB = await insertTag(b.familyId, "Trip", Buffer.from("trip"));
  });
  afterEach(async () => {
    if (!c) return;
    try {
      await c.rollback();
    } finally {
      c.release();
    }
    if (!a || !b) return;
    for (const table of [
      "user_favorites",
      "family_featured",
      "tags",
      "media_tags",
      "comments",
      "media_items",
      "upload_sessions",
      "storage_objects",
      "family_members",
    ]) {
      const [rows] = await database.pool.query<RowDataPacket[]>(
        `SELECT COUNT(*) n FROM ${table} WHERE family_id IN (?,?)`,
        [a.familyId, b.familyId],
      );
      expect(Number(rows[0]?.n)).toBe(0);
    }
    const [rows] = await database.pool.query<RowDataPacket[]>(
      "SELECT (SELECT COUNT(*) FROM families WHERE id IN (?,?))+(SELECT COUNT(*) FROM users WHERE id IN (?,?,?,?)) n",
      [
        a.familyId,
        b.familyId,
        a.userId,
        a.actorUserId,
        b.userId,
        b.actorUserId,
      ],
    );
    expect(Number(rows[0]?.n)).toBe(0);
  });
  afterAll(async () => {
    await database.pool.end();
  });

  async function insertTag(family: string, name: string, normalized: Buffer) {
    await c.query(
      "INSERT INTO tags (family_id,name,name_normalized) VALUES (?,?,?)",
      [family, name, normalized],
    );
    const [r] = await c.query<RowDataPacket[]>(
      "SELECT CAST(LAST_INSERT_ID() AS CHAR) id",
    );
    return String(r[0]!.id);
  }
  async function reject(sql: string, values: unknown[], errno: number) {
    await expect(c.query(sql, values)).rejects.toMatchObject({ errno });
  }
  const favorite =
    "INSERT INTO user_favorites (family_id,member_id,media_id) VALUES (?,?,?)";
  const featured =
    "INSERT INTO family_featured (family_id,featured_by_member_id,media_id) VALUES (?,?,?)";
  const link =
    "INSERT INTO media_tags (family_id,media_id,tag_id) VALUES (?,?,?)";
  const comment =
    "INSERT INTO comments (family_id,author_member_id,media_id,body) VALUES (?,?,?,?)";

  it.each([
    "favorite member",
    "favorite media",
    "featured member",
    "featured media",
    "tag media",
    "tag identity",
    "comment author",
    "comment media",
  ])("rejects cross-family %s with native ERROR 1452", async (kind) => {
    const probes: Record<string, [string, unknown[]]> = {
      "favorite member": [favorite, [a.familyId, b.actorMemberId, a.mediaId]],
      "favorite media": [favorite, [a.familyId, a.actorMemberId, b.mediaId]],
      "featured member": [featured, [a.familyId, b.actorMemberId, a.mediaId]],
      "featured media": [featured, [a.familyId, a.actorMemberId, b.mediaId]],
      "tag media": [link, [a.familyId, b.mediaId, tagA]],
      "tag identity": [link, [a.familyId, a.mediaId, tagB]],
      "comment author": [
        comment,
        [a.familyId, b.actorMemberId, a.mediaId, "synthetic"],
      ],
      "comment media": [
        comment,
        [a.familyId, a.actorMemberId, b.mediaId, "synthetic"],
      ],
    };
    const [sql, values] = probes[kind]!;
    await reject(sql, values, 1452);
  });
  it.each(["favorite", "featured", "normalized tag", "media tag"])(
    "rejects duplicate %s with ERROR 1062",
    async (kind) => {
      const probes: Record<string, [string, unknown[]]> = {
        favorite: [favorite, [a.familyId, a.actorMemberId, a.mediaId]],
        featured: [featured, [a.familyId, a.actorMemberId, a.mediaId]],
        "normalized tag": [
          "INSERT INTO tags (family_id,name,name_normalized) VALUES (?,?,?)",
          [a.familyId, "trip", Buffer.from("trip")],
        ],
        "media tag": [link, [a.familyId, a.mediaId, tagA]],
      };
      const [sql, values] = probes[kind]!;
      if (kind !== "normalized tag") await c.query(sql, values);
      await reject(sql, values, 1062);
    },
  );
  it.each(["favorite", "featured", "media tag", "comment"])(
    "RESTRICT protects media referenced by %s",
    async (kind) => {
      const probes: Record<string, [string, unknown[]]> = {
        favorite: [favorite, [a.familyId, a.actorMemberId, a.mediaId]],
        featured: [featured, [a.familyId, a.actorMemberId, a.mediaId]],
        "media tag": [link, [a.familyId, a.mediaId, tagA]],
        comment: [
          comment,
          [a.familyId, a.actorMemberId, a.mediaId, "synthetic"],
        ],
      };
      const [sql, values] = probes[kind]!;
      await c.query(sql, values);
      await reject(
        "DELETE FROM media_items WHERE family_id=? AND id=?",
        [a.familyId, a.mediaId],
        1451,
      );
    },
  );
  it.each(["favorite", "featured", "comment"])(
    "RESTRICT protects member referenced only by %s",
    async (kind) => {
      const sql =
        kind === "favorite"
          ? favorite
          : kind === "featured"
            ? featured
            : comment;
      await c.query(
        sql,
        kind === "comment"
          ? [a.familyId, a.actorMemberId, a.mediaId, "synthetic"]
          : [a.familyId, a.actorMemberId, a.mediaId],
      );
      await reject(
        "DELETE FROM family_members WHERE family_id=? AND id=?",
        [a.familyId, a.actorMemberId],
        1451,
      );
    },
  );
  it("RESTRICT protects an attached tag", async () => {
    await c.query(link, [a.familyId, a.mediaId, tagA]);
    await reject(
      "DELETE FROM tags WHERE family_id=? AND id=?",
      [a.familyId, tagA],
      1451,
    );
  });
  it("preserves binary canonical bytes, family-local uniqueness and utf8mb4 text", async () => {
    const id = await insertTag(a.familyId, "é", Buffer.from("é"));
    await insertTag(a.familyId, "e", Buffer.from("e"));
    await insertTag(a.familyId, "ß", Buffer.from("ß"));
    await insertTag(a.familyId, "ss", Buffer.from("ss"));
    await insertTag(a.familyId, "😀".repeat(64), Buffer.from("😀".repeat(64)));
    const [rows] = await c.query<RowDataPacket[]>(
      "SELECT name_normalized FROM tags WHERE id=? AND family_id=?",
      [id, a.familyId],
    );
    expect(rows[0]?.name_normalized).toEqual(Buffer.from("é"));
    await c.query(comment, [
      a.familyId,
      a.actorMemberId,
      a.mediaId,
      "😀".repeat(2000),
    ]);
  });
  it("enforces tag/comment CHECK lower bounds and native upper lengths", async () => {
    await reject(
      "INSERT INTO tags (family_id,name,name_normalized) VALUES (?,?,?)",
      [a.familyId, "", Buffer.from("new")],
      3819,
    );
    await reject(
      "INSERT INTO tags (family_id,name,name_normalized) VALUES (?,?,?)",
      [a.familyId, "new", Buffer.alloc(0)],
      3819,
    );
    await reject(
      "INSERT INTO tags (family_id,name,name_normalized) VALUES (?,?,?)",
      [a.familyId, "x".repeat(65), Buffer.from("new")],
      1406,
    );
    await reject(
      "INSERT INTO tags (family_id,name,name_normalized) VALUES (?,?,?)",
      [a.familyId, "new", Buffer.alloc(257)],
      1406,
    );
    await reject(comment, [a.familyId, a.actorMemberId, a.mediaId, ""], 3819);
    await reject(
      comment,
      [a.familyId, a.actorMemberId, a.mediaId, "x".repeat(2001)],
      1406,
    );
  });
  it("defaults canonical note to NULL/1 and accepts only bounded note values/revisions", async () => {
    const [before] = await c.query<RowDataPacket[]>(
      "SELECT * FROM media_items WHERE family_id=? AND id=?",
      [a.familyId, a.mediaId],
    );
    expect(before[0]?.description).toBeNull();
    expect(String(before[0]?.note_revision)).toBe("1");
    await c.query(
      "UPDATE media_items SET description=?,note_revision=? WHERE family_id=? AND id=?",
      ["😀".repeat(4000), "9007199254740993", a.familyId, a.mediaId],
    );
    const [after] = await c.query<RowDataPacket[]>(
      "SELECT * FROM media_items WHERE family_id=? AND id=?",
      [a.familyId, a.mediaId],
    );
    expect(after[0]?.description).toBe("😀".repeat(4000));
    expect(String(after[0]?.note_revision)).toBe("9007199254740993");
    const unchanged = (row: RowDataPacket) =>
      Object.fromEntries(
        Object.entries(row).filter(
          ([k]) => !["description", "note_revision"].includes(k),
        ),
      );
    expect(unchanged(after[0]!)).toEqual(unchanged(before[0]!));
    await reject(
      "UPDATE media_items SET note_revision=0 WHERE family_id=? AND id=?",
      [a.familyId, a.mediaId],
      3819,
    );
    await reject(
      "UPDATE media_items SET description='' WHERE family_id=? AND id=?",
      [a.familyId, a.mediaId],
      3819,
    );
    await reject(
      "UPDATE media_items SET description=? WHERE family_id=? AND id=?",
      ["x".repeat(4001), a.familyId, a.mediaId],
      1406,
    );
    await c.query(
      "UPDATE media_items SET description=NULL WHERE family_id=? AND id=?",
      [a.familyId, a.mediaId],
    );
  });
});
