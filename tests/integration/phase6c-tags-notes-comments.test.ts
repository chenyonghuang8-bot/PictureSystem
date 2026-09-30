import { randomBytes, randomUUID } from "node:crypto";

import type {
  Pool,
  PoolConnection,
  ResultSetHeader,
  RowDataPacket,
} from "mysql2/promise";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  AlbumRepositoryError,
  assertMigrationReadiness,
  createDatabase,
  MySqlAlbumRepository,
} from "../../packages/db/src/index.js";
import type {
  AlbumRepositoryTestEvent,
  AlbumRepositoryTestOperation,
} from "../../packages/db/src/album-repository-test-hooks.js";
import { albumRaceBarrier } from "../../packages/db/src/album-race-barrier-test-helper.js";
import { normalizeTagName } from "../../apps/api/src/albums/text.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("PHASE6C_DEV_DATABASE_URL_REQUIRED");

describe.sequential("Phase 6C tags, notes and comments", () => {
  const database = createDatabase(databaseUrl);
  const albums = new MySqlAlbumRepository(database.pool);
  const suffix = randomUUID().replaceAll("-", "");
  let familyId = "";
  let otherFamilyId = "";
  let owner = identity();
  let superAdmin = identity();
  let editor = identity();
  let viewer = identity();
  let hiddenOwner = identity();
  let outsider = identity();
  let albumA = "";
  let albumB = "";
  let hiddenAlbum = "";
  let mediaId = "";
  let hiddenMediaId = "";
  let capMediaId = "";
  let unplacedMediaId = "";
  let hiddenTagId = "";
  let crossFamilyTagId = "";

  beforeAll(async () => {
    const connection = await database.pool.getConnection();
    try {
      await preflight(connection);
      familyId = await insertFamily(connection, `Phase 6C ${suffix}`);
      otherFamilyId = await insertFamily(
        connection,
        `Phase 6C other ${suffix}`,
      );
      owner = await insertIdentity(
        connection,
        familyId,
        suffix,
        "owner",
        "ADMIN",
      );
      superAdmin = await insertIdentity(
        connection,
        familyId,
        suffix,
        "super",
        "SUPER_ADMIN",
      );
      editor = await insertIdentity(
        connection,
        familyId,
        suffix,
        "editor",
        "MEMBER",
      );
      viewer = await insertIdentity(
        connection,
        familyId,
        suffix,
        "viewer",
        "MEMBER",
      );
      hiddenOwner = await insertIdentity(
        connection,
        familyId,
        suffix,
        "hidden",
        "MEMBER",
      );
      outsider = await insertIdentity(
        connection,
        otherFamilyId,
        suffix,
        "outsider",
        "SUPER_ADMIN",
      );
      albumA = await insertAlbum(connection, familyId, owner.memberId, "A");
      albumB = await insertAlbum(connection, familyId, editor.memberId, "B");
      hiddenAlbum = await insertAlbum(
        connection,
        familyId,
        hiddenOwner.memberId,
        "Hidden",
      );
      await putGrant(connection, familyId, albumA, editor.memberId, true);
      await putGrant(connection, familyId, albumA, viewer.memberId, false);
      mediaId = await insertMedia(connection, familyId, owner.memberId);
      hiddenMediaId = await insertMedia(connection, familyId, owner.memberId);
      capMediaId = await insertMedia(connection, familyId, owner.memberId);
      unplacedMediaId = await insertMedia(connection, familyId, owner.memberId);
      await connection.query(
        `INSERT INTO album_media (family_id,album_id,media_id)
         VALUES (?,?,?),(?,?,?),(?,?,?),(?,?,?)`,
        [
          familyId,
          albumA,
          mediaId,
          familyId,
          albumB,
          mediaId,
          familyId,
          hiddenAlbum,
          hiddenMediaId,
          familyId,
          albumA,
          capMediaId,
        ],
      );
      hiddenTagId = await insertTag(connection, familyId, "Secret", "secret");
      await connection.query(
        "INSERT INTO media_tags (family_id,media_id,tag_id) VALUES (?,?,?)",
        [familyId, hiddenMediaId, hiddenTagId],
      );
      crossFamilyTagId = await insertTag(
        connection,
        otherFamilyId,
        "Other",
        "other",
      );
    } finally {
      connection.release();
    }
  });

  afterAll(async () => {
    for (const id of [familyId, otherFamilyId].filter(Boolean)) {
      await database.pool.query("DELETE FROM comments WHERE family_id=?", [id]);
      await database.pool.query("DELETE FROM media_tags WHERE family_id=?", [
        id,
      ]);
      await database.pool.query("DELETE FROM tags WHERE family_id=?", [id]);
      await database.pool.query(
        "DELETE FROM user_favorites WHERE family_id=?",
        [id],
      );
      await database.pool.query(
        "DELETE FROM family_featured WHERE family_id=?",
        [id],
      );
      await database.pool.query(
        "DELETE FROM derived_assets WHERE family_id=?",
        [id],
      );
      await database.pool.query(
        "DELETE FROM background_jobs WHERE family_id=?",
        [id],
      );
      await database.pool.query("DELETE FROM album_media WHERE family_id=?", [
        id,
      ]);
      await database.pool.query("DELETE FROM album_members WHERE family_id=?", [
        id,
      ]);
      await database.pool.query("DELETE FROM media_items WHERE family_id=?", [
        id,
      ]);
      await database.pool.query(
        "DELETE FROM upload_sessions WHERE family_id=?",
        [id],
      );
      await database.pool.query(
        "DELETE FROM storage_objects WHERE family_id=?",
        [id],
      );
      await database.pool.query("DELETE FROM albums WHERE family_id=?", [id]);
      await database.pool.query(
        "DELETE s FROM sessions s JOIN family_members m ON m.user_id=s.user_id WHERE m.family_id=?",
        [id],
      );
      const [users] = await database.pool.query<RowDataPacket[]>(
        "SELECT CAST(user_id AS CHAR) AS userId FROM family_members WHERE family_id=?",
        [id],
      );
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
    await database.pool.end();
  });

  it("atomically converges Unicode whitespace and case variants to one canonical tag", async () => {
    const variants = ["Trip", "\u0085Trip\u0085", " trip ", "TRIP"];
    const applied = await Promise.all(
      variants.map((input) => {
        const normalized = normalizeTagName(input);
        return albums.createAndApplyMediaTag({
          actor: actor(editor),
          albumId: albumA,
          mediaId,
          name: normalized.name,
          normalizedName: normalized.normalizedBytes,
        });
      }),
    );
    expect(new Set(applied.map((tag) => tag.id)).size).toBe(1);
    const first = applied[0]!;
    expect(
      await albums.listMediaTags({
        actor: actor(viewer),
        albumId: albumA,
        mediaId,
      }),
    ).toEqual([{ id: first.id, name: first.name }]);
    const [counts] = await database.pool.query<RowDataPacket[]>(
      `SELECT (SELECT COUNT(*) FROM tags WHERE family_id=? AND name_normalized=?) AS tags,
              (SELECT COUNT(*) FROM media_tags WHERE family_id=? AND media_id=? AND tag_id=?) AS links`,
      [familyId, Buffer.from("trip"), familyId, mediaId, first.id],
    );
    expect(String(counts[0]?.tags)).toBe("1");
    expect(String(counts[0]?.links)).toBe("1");
    for (const [left, right] of [
      ["é", "e"],
      ["ß", "ss"],
    ] as const) {
      expect(
        normalizeTagName(left).normalizedBytes.equals(
          normalizeTagName(right).normalizedBytes,
        ),
      ).toBe(false);
    }
  });

  it("serializes the 64-tag cap while preserving idempotency and remove semantics", async () => {
    const connection = await database.pool.getConnection();
    const tagIds: string[] = [];
    try {
      for (let index = 0; index < 63; index += 1) {
        const tagId = await insertTag(
          connection,
          familyId,
          `Cap ${index}`,
          `cap ${index}`,
        );
        tagIds.push(tagId);
        await connection.query(
          "INSERT INTO media_tags (family_id,media_id,tag_id) VALUES (?,?,?)",
          [familyId, capMediaId, tagId],
        );
      }
    } finally {
      connection.release();
    }
    const raced = await Promise.allSettled([
      albums.createAndApplyMediaTag({
        actor: actor(editor),
        albumId: albumA,
        mediaId: capMediaId,
        name: "Cap race A",
        normalizedName: Buffer.from("cap race a"),
      }),
      albums.createAndApplyMediaTag({
        actor: actor(editor),
        albumId: albumA,
        mediaId: capMediaId,
        name: "Cap race B",
        normalizedName: Buffer.from("cap race b"),
      }),
    ]);
    expect(
      raced.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    expect(raced.filter((result) => result.status === "rejected")).toHaveLength(
      1,
    );
    expect(
      await albums.listMediaTags({
        actor: actor(viewer),
        albumId: albumA,
        mediaId: capMediaId,
      }),
    ).toHaveLength(64);
    await expect(
      albums.createAndApplyMediaTag({
        actor: actor(editor),
        albumId: albumA,
        mediaId: capMediaId,
        name: "Cap 0",
        normalizedName: Buffer.from("cap 0"),
      }),
    ).resolves.toMatchObject({ id: tagIds[0] });
    await expect(
      albums.createAndApplyMediaTag({
        actor: actor(editor),
        albumId: albumA,
        mediaId: capMediaId,
        name: "Cap 65",
        normalizedName: Buffer.from("cap 65"),
      }),
    ).rejects.toMatchObject({ reason: "CONFLICT" });
    await expect(
      albums.applyMediaTag({
        actor: actor(editor),
        albumId: albumA,
        mediaId: capMediaId,
        tagId: tagIds[1]!,
      }),
    ).resolves.toMatchObject({ id: tagIds[1] });
    const removals = await Promise.all([
      albums.removeMediaTag({
        actor: actor(editor),
        albumId: albumA,
        mediaId: capMediaId,
        tagId: tagIds[0]!,
      }),
      albums.removeMediaTag({
        actor: actor(editor),
        albumId: albumA,
        mediaId: capMediaId,
        tagId: tagIds[0]!,
      }),
    ]);
    expect(removals).toEqual([
      expect.objectContaining({ removed: true }),
      expect.objectContaining({ removed: true }),
    ]);
  });

  it("applies a visible existing tag idempotently without exposing hidden dictionaries", async () => {
    const target = await harnessMedia();
    const [visible] = await albums.listMediaTags({
      actor: actor(editor),
      albumId: albumA,
      mediaId,
    });
    expect(visible).toBeDefined();
    await expect(
      albums.applyMediaTag({
        actor: actor(editor),
        albumId: albumA,
        mediaId: target,
        tagId: visible!.id,
      }),
    ).resolves.toMatchObject({ id: visible!.id });
    await expect(
      albums.applyMediaTag({
        actor: actor(editor),
        albumId: albumA,
        mediaId: target,
        tagId: visible!.id,
      }),
    ).resolves.toMatchObject({ id: visible!.id });
    const [rows] = await database.pool.query<RowDataPacket[]>(
      "SELECT COUNT(*) AS count FROM media_tags WHERE family_id=? AND media_id=? AND tag_id=?",
      [familyId, target, visible!.id],
    );
    expect(String(rows[0]?.count)).toBe("1");
    for (const tagId of [hiddenTagId, crossFamilyTagId]) {
      await expect(
        albums.applyMediaTag({
          actor: actor(editor),
          albumId: albumA,
          mediaId: target,
          tagId,
        }),
      ).rejects.toMatchObject({ reason: "NOT_FOUND" });
    }
  });

  it("enforces edit permission and prevents hidden/cross-family tag oracles", async () => {
    await expect(
      albums.createAndApplyMediaTag({
        actor: actor(viewer),
        albumId: albumA,
        mediaId,
        name: "Viewer",
        normalizedName: Buffer.from("viewer"),
      }),
    ).rejects.toMatchObject({ reason: "FORBIDDEN" });
    for (const tagId of [hiddenTagId, crossFamilyTagId]) {
      await expect(
        albums.applyMediaTag({
          actor: actor(editor),
          albumId: albumA,
          mediaId,
          tagId,
        }),
      ).rejects.toMatchObject({ reason: "NOT_FOUND" });
    }
    await expect(
      albums.applyMediaTag({
        actor: actor(outsider),
        albumId: albumA,
        mediaId,
        tagId: hiddenTagId,
      }),
    ).rejects.toMatchObject({ reason: "NOT_FOUND" });
    await expect(
      albums.removeMediaTag({
        actor: actor(editor),
        albumId: albumA,
        mediaId,
        tagId: crossFamilyTagId,
      }),
    ).resolves.toMatchObject({ removed: true });
  });

  it("uses canonical note CAS across albums and admits exactly one concurrent writer", async () => {
    const attempts = await Promise.allSettled([
      albums.updateMediaNote({
        actor: actor(editor),
        albumId: albumA,
        mediaId,
        note: "first",
        expectedRevision: "1",
      }),
      albums.updateMediaNote({
        actor: actor(editor),
        albumId: albumB,
        mediaId,
        note: "second",
        expectedRevision: "1",
      }),
    ]);
    expect(
      attempts.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    const rejected = attempts.find((result) => result.status === "rejected");
    expect((rejected as PromiseRejectedResult).reason).toBeInstanceOf(
      AlbumRepositoryError,
    );
    expect((rejected as PromiseRejectedResult).reason.reason).toBe("CONFLICT");
    const detailA = await albums.getAlbumMedia({
      actor: actor(editor),
      albumId: albumA,
      mediaId,
    });
    const detailB = await albums.getAlbumMedia({
      actor: actor(editor),
      albumId: albumB,
      mediaId,
    });
    expect(detailA.noteRevision).toBe("2");
    expect(detailB.note).toBe(detailA.note);
    await expect(
      albums.updateMediaNote({
        actor: actor(editor),
        albumId: albumA,
        mediaId,
        note: detailA.note,
        expectedRevision: "1",
      }),
    ).rejects.toMatchObject({ reason: "CONFLICT" });
    await database.pool.query(
      "UPDATE media_items SET note_revision=18446744073709551615 WHERE family_id=? AND id=?",
      [familyId, mediaId],
    );
    await expect(
      albums.updateMediaNote({
        actor: actor(editor),
        albumId: albumA,
        mediaId,
        note: "overflow",
        expectedRevision: "18446744073709551615",
      }),
    ).rejects.toMatchObject({ reason: "CONFLICT" });
    await database.pool.query(
      "UPDATE media_items SET note_revision=2 WHERE family_id=? AND id=?",
      [familyId, mediaId],
    );
  });

  it("hides cross-family, no-placement and role-only targets before Phase 6C state", async () => {
    for (const operation of [
      () =>
        albums.updateMediaNote({
          actor: actor(outsider),
          albumId: albumA,
          mediaId,
          note: "x",
          expectedRevision: "2",
        }),
      () =>
        albums.listMediaComments({
          actor: actor(superAdmin),
          albumId: hiddenAlbum,
          mediaId: hiddenMediaId,
          limit: 20,
        }),
      () =>
        albums.listMediaTags({
          actor: actor(owner),
          albumId: albumA,
          mediaId: unplacedMediaId,
        }),
    ]) {
      await expect(operation()).rejects.toMatchObject({ reason: "NOT_FOUND" });
    }
  });

  it("paginates comments, derives authors, and only lets authors delete", async () => {
    const first = await albums.createMediaComment({
      actor: actor(viewer),
      albumId: albumA,
      mediaId,
      body: "<b>plain</b>",
      admit: () => undefined,
    });
    const second = await albums.createMediaComment({
      actor: actor(editor),
      albumId: albumA,
      mediaId,
      body: "second",
      admit: () => undefined,
    });
    const tiedAt = new Date("2026-06-01T00:00:00.000Z");
    await database.pool.query(
      "UPDATE comments SET created_at=? WHERE family_id=? AND id IN (?,?)",
      [tiedAt, familyId, first.id, second.id],
    );
    expect(first.author.memberId).toBe(viewer.memberId);
    const page = await albums.listMediaComments({
      actor: actor(viewer),
      albumId: albumA,
      mediaId,
      limit: 1,
    });
    expect(page).toHaveLength(1);
    expect(page[0]?.body).toBe("<b>plain</b>");
    const next = await albums.listMediaComments({
      actor: actor(viewer),
      albumId: albumA,
      mediaId,
      limit: 2,
      cursor: { createdAt: page[0]!.createdAt, id: page[0]!.id },
    });
    expect(next.map((comment) => comment.id)).toContain(second.id);
    await expect(
      albums.deleteMediaComment({
        actor: actor(owner),
        albumId: albumA,
        mediaId,
        commentId: first.id,
      }),
    ).rejects.toMatchObject({ reason: "FORBIDDEN" });
    const deletes = await Promise.allSettled([
      albums.deleteMediaComment({
        actor: actor(viewer),
        albumId: albumA,
        mediaId,
        commentId: first.id,
      }),
      albums.deleteMediaComment({
        actor: actor(viewer),
        albumId: albumA,
        mediaId,
        commentId: first.id,
      }),
    ]);
    expect(
      deletes.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    expect(
      deletes.filter((result) => result.status === "rejected"),
    ).toHaveLength(1);
    const rejectedDelete = deletes.find(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );
    expect(rejectedDelete?.reason).toMatchObject({ reason: "NOT_FOUND" });
    const [remaining] = await database.pool.query<RowDataPacket[]>(
      "SELECT COUNT(*) AS count FROM comments WHERE family_id=? AND media_id=? AND id=?",
      [familyId, mediaId, first.id],
    );
    expect(String(remaining[0]?.count)).toBe("0");
  });

  it("rechecks ACL, placement and membership before comment and note mutations", async () => {
    await database.pool.query(
      "UPDATE album_members SET can_edit=0 WHERE family_id=? AND album_id=? AND member_id=?",
      [familyId, albumA, editor.memberId],
    );
    await expect(
      albums.updateMediaNote({
        actor: actor(editor),
        albumId: albumA,
        mediaId,
        note: "denied",
        expectedRevision: "2",
      }),
    ).rejects.toMatchObject({ reason: "FORBIDDEN" });
    await database.pool.query(
      "UPDATE album_members SET can_edit=1 WHERE family_id=? AND album_id=? AND member_id=?",
      [familyId, albumA, editor.memberId],
    );

    await database.pool.query(
      "DELETE FROM album_media WHERE family_id=? AND album_id=? AND media_id=?",
      [familyId, albumA, mediaId],
    );
    await expect(
      albums.createMediaComment({
        actor: actor(viewer),
        albumId: albumA,
        mediaId,
        body: "denied",
        admit: () => undefined,
      }),
    ).rejects.toMatchObject({ reason: "NOT_FOUND" });
    await database.pool.query(
      "INSERT INTO album_media (family_id,album_id,media_id) VALUES (?,?,?)",
      [familyId, albumA, mediaId],
    );

    await database.pool.query(
      "UPDATE family_members SET disabled_at=CURRENT_TIMESTAMP(3) WHERE family_id=? AND id=?",
      [familyId, viewer.memberId],
    );
    await expect(
      albums.createMediaComment({
        actor: actor(viewer),
        albumId: albumA,
        mediaId,
        body: "denied",
        admit: () => undefined,
      }),
    ).rejects.toMatchObject({ reason: "UNAUTHENTICATED" });
    await database.pool.query(
      "UPDATE family_members SET disabled_at=NULL WHERE family_id=? AND id=?",
      [familyId, viewer.memberId],
    );
    await database.pool.query(
      "UPDATE family_members SET left_at=CURRENT_TIMESTAMP(3) WHERE family_id=? AND id=?",
      [familyId, viewer.memberId],
    );
    await expect(
      albums.createMediaComment({
        actor: actor(viewer),
        albumId: albumA,
        mediaId,
        body: "denied",
        admit: () => undefined,
      }),
    ).rejects.toMatchObject({ reason: "UNAUTHENTICATED" });
    await database.pool.query(
      "UPDATE family_members SET left_at=NULL WHERE family_id=? AND id=?",
      [familyId, viewer.memberId],
    );

    const historical = await albums.createMediaComment({
      actor: actor(viewer),
      albumId: albumA,
      mediaId,
      body: "historical",
      admit: () => undefined,
    });
    await database.pool.query(
      "UPDATE album_members SET can_view=0 WHERE family_id=? AND album_id=? AND member_id=?",
      [familyId, albumA, viewer.memberId],
    );
    await expect(
      albums.listMediaComments({
        actor: actor(viewer),
        albumId: albumA,
        mediaId,
        limit: 20,
      }),
    ).rejects.toMatchObject({ reason: "NOT_FOUND" });
    await expect(
      albums.deleteMediaComment({
        actor: actor(viewer),
        albumId: albumA,
        mediaId,
        commentId: historical.id,
      }),
    ).rejects.toMatchObject({ reason: "NOT_FOUND" });
    await database.pool.query(
      "UPDATE album_members SET can_view=1 WHERE family_id=? AND album_id=? AND member_id=?",
      [familyId, albumA, viewer.memberId],
    );

    await database.pool.query(
      "UPDATE family_members SET disabled_at=CURRENT_TIMESTAMP(3) WHERE family_id=? AND id=?",
      [familyId, editor.memberId],
    );
    const visibleHistory = await albums.listMediaComments({
      actor: actor(owner),
      albumId: albumA,
      mediaId,
      limit: 50,
    });
    expect(
      visibleHistory.some(
        (comment) => comment.author.memberId === editor.memberId,
      ),
    ).toBe(true);
    await database.pool.query(
      "UPDATE family_members SET disabled_at=NULL WHERE family_id=? AND id=?",
      [familyId, editor.memberId],
    );
  });

  it("preserves canonical, storage, placement and derived state around real Phase 6C mutations", async () => {
    const target = await preservationMedia();
    const before = await preservationSnapshot(target);
    const tag = await albums.createAndApplyMediaTag(
      createTagInput(target, `preservation-${suffix}`),
    );
    await expect(
      albums.updateMediaNote({
        ...noteInput(target),
        note: "preserved note",
      }),
    ).resolves.toMatchObject({ noteRevision: "2" });
    const comment = await albums.createMediaComment(
      commentInput(target, "temporary preservation comment"),
    );
    await albums.deleteMediaComment({
      actor: actor(viewer),
      albumId: albumA,
      mediaId: target,
      commentId: comment.id,
    });
    await albums.removeMediaTag(tagInput(target, tag.id));
    const after = await preservationSnapshot(target);
    expect(after).toEqual({
      ...before,
      media: {
        ...before.media,
        description: "preserved note",
        noteRevision: "2",
      },
    });
    expect(await tagRelationCount(target, tag.id)).toBe("0");
    expect(await commentCount(target)).toBe("0");
    const detail = await albums.getAlbumMedia({
      actor: actor(editor),
      albumId: albumA,
      mediaId: target,
    });
    expect(detail).toMatchObject({
      tags: [],
      note: "preserved note",
      noteRevision: "2",
      commentCount: "0",
      capabilities: {
        canEditTags: true,
        canEditNote: true,
        canComment: true,
        canDownloadOriginal: true,
        canDownloadPreview: true,
      },
    });
  });

  describe("deterministic race harness", () => {
    it("proves existing-tag PUT state-first ACL and placement ordering", async () => {
      const tag = await visibleRaceTag("put-state");
      const aclTarget = await harnessMedia();
      try {
        const outcome = await stateFirst(
          "TAG_APPLY_EXISTING",
          (repository) => repository.applyMediaTag(tagInput(aclTarget, tag.id)),
          (connection) => setHarnessEdit(connection, false),
        );
        expect(outcome).toMatchObject({ reason: "FORBIDDEN" });
        expect(await tagRelationCount(aclTarget, tag.id)).toBe("0");
        await expectMediaVisible(aclTarget, true);
      } finally {
        await setHarnessEdit(database.pool, true);
      }

      const placementTarget = await harnessMedia();
      try {
        const outcome = await stateFirst(
          "TAG_APPLY_EXISTING",
          (repository) =>
            repository.applyMediaTag(tagInput(placementTarget, tag.id)),
          (connection) => removeHarnessPlacement(connection, placementTarget),
        );
        expect(outcome).toMatchObject({ reason: "NOT_FOUND" });
        expect(await tagRelationCount(placementTarget, tag.id)).toBe("0");
        await expectMediaVisible(placementTarget, false);
      } finally {
        await restoreHarnessPlacement(placementTarget);
      }
    });

    it("proves existing-tag PUT commits before placement removal without granting access", async () => {
      const tag = await visibleRaceTag("put-first");
      const target = await harnessMedia();
      const result = await mutationFirst(
        "TAG_APPLY_EXISTING",
        (repository) => repository.applyMediaTag(tagInput(target, tag.id)),
        (connection) => removeHarnessPlacement(connection, target),
      );
      expect(result).toMatchObject({ id: tag.id });
      expect(await tagRelationCount(target, tag.id)).toBe("1");
      await expectMediaVisible(target, false);
      await expect(
        albums.listMediaTags({
          actor: actor(editor),
          albumId: albumA,
          mediaId: target,
        }),
      ).rejects.toMatchObject({ reason: "NOT_FOUND" });
      await restoreHarnessPlacement(target);
    });

    it("proves tag POST state-first and mutation-first authorization ordering", async () => {
      const aclTarget = await harnessMedia();
      const aclName = `post-acl-${suffix}`;
      try {
        const outcome = await stateFirst(
          "TAG_CREATE_APPLY",
          (repository) =>
            repository.createAndApplyMediaTag(
              createTagInput(aclTarget, aclName),
            ),
          (connection) => setHarnessEdit(connection, false),
        );
        expect(outcome).toMatchObject({ reason: "FORBIDDEN" });
        expect(await tagIdentityCount(aclName)).toBe("0");
        await expectMediaVisible(aclTarget, true);
      } finally {
        await setHarnessEdit(database.pool, true);
      }

      const placementTarget = await harnessMedia();
      const placementName = `post-placement-${suffix}`;
      try {
        const outcome = await stateFirst(
          "TAG_CREATE_APPLY",
          (repository) =>
            repository.createAndApplyMediaTag(
              createTagInput(placementTarget, placementName),
            ),
          (connection) => removeHarnessPlacement(connection, placementTarget),
        );
        expect(outcome).toMatchObject({ reason: "NOT_FOUND" });
        expect(await tagIdentityCount(placementName)).toBe("0");
        await expectMediaVisible(placementTarget, false);
      } finally {
        await restoreHarnessPlacement(placementTarget);
      }

      const firstTarget = await harnessMedia();
      const firstName = `post-first-${suffix}`;
      const created = await mutationFirst(
        "TAG_CREATE_APPLY",
        (repository) =>
          repository.createAndApplyMediaTag(
            createTagInput(firstTarget, firstName),
          ),
        (connection) => removeHarnessPlacement(connection, firstTarget),
      );
      expect(await tagRelationCount(firstTarget, created.id)).toBe("1");
      await expectMediaVisible(firstTarget, false);
      await restoreHarnessPlacement(firstTarget);
    });

    it("requires current authorization before idempotent tag DELETE", async () => {
      const tag = await visibleRaceTag("delete-state");
      const target = await harnessMedia();
      await albums.applyMediaTag(tagInput(target, tag.id));
      try {
        const outcome = await stateFirst(
          "TAG_REMOVE",
          (repository) => repository.removeMediaTag(tagInput(target, tag.id)),
          (connection) => setHarnessEdit(connection, false),
        );
        expect(outcome).toMatchObject({ reason: "FORBIDDEN" });
        expect(await tagRelationCount(target, tag.id)).toBe("1");
        await expectMediaVisible(target, true);
      } finally {
        await setHarnessEdit(database.pool, true);
      }
    });

    it("returns hidden semantics before stale note conflict state", async () => {
      const target = await harnessMedia();
      try {
        const outcome = await stateFirst(
          "NOTE_UPDATE",
          (repository) =>
            repository.updateMediaNote({
              ...noteInput(target),
              expectedRevision: "0",
              note: "stale hidden",
            }),
          (connection) => setHarnessView(connection, editor.memberId, false),
        );
        expect(outcome).toMatchObject({ reason: "NOT_FOUND" });
        await expectMediaRow(target, null, "1");
        await expectMediaVisible(target, false);
      } finally {
        await setHarnessView(database.pool, editor.memberId, true);
        await setHarnessEdit(database.pool, true);
      }
    });

    it("proves comment CREATE state-first lifecycle ordering", async () => {
      const cases = [
        {
          label: "acl",
          state: (connection: PoolConnection) =>
            setHarnessView(connection, viewer.memberId, false),
          restore: () => setHarnessView(database.pool, viewer.memberId, true),
          reason: "NOT_FOUND",
          visible: false,
        },
        {
          label: "placement",
          state: (connection: PoolConnection, target: string) =>
            removeHarnessPlacement(connection, target),
          restore: (target: string) => restoreHarnessPlacement(target),
          reason: "NOT_FOUND",
          visible: false,
        },
        {
          label: "disable",
          state: (connection: PoolConnection) =>
            setMemberLifecycle(
              connection,
              viewer.memberId,
              "disabled_at",
              true,
            ),
          restore: () =>
            setMemberLifecycle(
              database.pool,
              viewer.memberId,
              "disabled_at",
              false,
            ),
          reason: "UNAUTHENTICATED",
          visible: false,
        },
        {
          label: "leave",
          state: (connection: PoolConnection) =>
            setMemberLifecycle(connection, viewer.memberId, "left_at", true),
          restore: () =>
            setMemberLifecycle(
              database.pool,
              viewer.memberId,
              "left_at",
              false,
            ),
          reason: "UNAUTHENTICATED",
          visible: false,
        },
      ] as const;
      for (const testCase of cases) {
        const target = await harnessMedia();
        try {
          const outcome = await stateFirst(
            "COMMENT_CREATE",
            (repository) =>
              repository.createMediaComment(
                commentInput(target, testCase.label),
              ),
            (connection) => testCase.state(connection, target),
          );
          expect(outcome).toMatchObject({ reason: testCase.reason });
          expect(await commentCount(target)).toBe("0");
          await expectMediaVisible(target, testCase.visible, viewer);
        } finally {
          await testCase.restore(target);
        }
      }
    });

    it("keeps a mutation-first comment historical without restoring access", async () => {
      const target = await harnessMedia();
      const comment = await mutationFirst(
        "COMMENT_CREATE",
        (repository) =>
          repository.createMediaComment(commentInput(target, "mutation-first")),
        (connection) => setHarnessView(connection, viewer.memberId, false),
      );
      expect(await commentCount(target)).toBe("1");
      await expectMediaVisible(target, false, viewer);
      await expect(
        albums.listMediaComments({
          actor: actor(viewer),
          albumId: albumA,
          mediaId: target,
          limit: 20,
        }),
      ).rejects.toMatchObject({ reason: "NOT_FOUND" });
      expect(comment.author.memberId).toBe(viewer.memberId);
      await setHarnessView(database.pool, viewer.memberId, true);
    });

    it("does not let historical comment authorship authorize visibility-first DELETE", async () => {
      const target = await harnessMedia();
      const comment = await albums.createMediaComment(
        commentInput(target, "delete visibility"),
      );
      try {
        const outcome = await stateFirst(
          "COMMENT_DELETE",
          (repository) =>
            repository.deleteMediaComment({
              actor: actor(viewer),
              albumId: albumA,
              mediaId: target,
              commentId: comment.id,
            }),
          (connection) => setHarnessView(connection, viewer.memberId, false),
        );
        expect(outcome).toMatchObject({ reason: "NOT_FOUND" });
        expect(await commentCount(target)).toBe("1");
        await expectMediaVisible(target, false, viewer);
      } finally {
        await setHarnessView(database.pool, viewer.memberId, true);
      }
    });

    it("observes a committed edit revoke after dispatching the blocked family lock", async () => {
      const target = await harnessMedia();
      const latch = albumRaceBarrier({
        operation: "NOTE_UPDATE",
        stage: "FAMILY_LOCK_QUERY_DISPATCHED",
      });
      const events: AlbumRepositoryTestEvent[] = [];
      const repository = new MySqlAlbumRepository(database.pool, {
        testHook: async (event) => {
          events.push(event);
          await latch.hook(event);
        },
      });
      const state = await database.pool.getConnection();
      let committed = false;
      let outcome: Promise<unknown> | undefined;
      try {
        await state.beginTransaction();
        await state.query("SELECT id FROM families WHERE id=? FOR UPDATE", [
          familyId,
        ]);
        await setHarnessEdit(state, false);
        outcome = repository.updateMediaNote(noteInput(target)).then(
          () => "UNEXPECTED_SUCCESS",
          (error: unknown) => error,
        );
        expect(await latch.wait()).toEqual({
          operation: "NOTE_UPDATE",
          stage: "FAMILY_LOCK_QUERY_DISPATCHED",
          familyId,
        });
        await state.commit();
        committed = true;
        expect(await outcome).toMatchObject({ reason: "FORBIDDEN" });
        expect(events.map((event) => event.stage)).toEqual([
          "FAMILY_LOCK_QUERY_DISPATCHED",
        ]);
        await expectHarnessState(target, null, "1", false);
      } finally {
        latch.release();
        if (!committed) await state.rollback();
        await outcome;
        await setHarnessEdit(state, true);
        state.release();
      }
    });

    it("commits an authorized mutation before the already-dispatched edit revoke", async () => {
      const target = await harnessMedia();
      const latch = albumRaceBarrier(
        {
          operation: "NOTE_UPDATE",
          stage: "MUTATION_APPLIED_BEFORE_COMMIT",
        },
        { pause: true },
      );
      const repository = new MySqlAlbumRepository(database.pool, {
        testHook: latch.hook,
      });
      const state = await database.pool.getConnection();
      const mutation = repository.updateMediaNote(noteInput(target));
      void mutation.catch(() => undefined);
      let stateStarted = false;
      let stateLock: Promise<unknown> | undefined;
      try {
        expect((await latch.wait()).familyId).toBe(familyId);
        await state.beginTransaction();
        stateStarted = true;
        // mysql2 invokes its underlying query before returning this promise.
        // The repository still owns this row lock at the paused pre-commit hook.
        stateLock = state.query(
          "SELECT id FROM families WHERE id=? FOR UPDATE",
          [familyId],
        );
        void stateLock.catch(() => undefined);
        latch.release();
        await stateLock;
        // Read inside the state transaction after acquiring the lock: the note
        // was committed before this state transaction can perform its revoke.
        const [rows] = await state.query<RowDataPacket[]>(
          "SELECT description, CAST(note_revision AS CHAR) AS revision FROM media_items WHERE family_id=? AND id=?",
          [familyId, target],
        );
        expect(rows[0]).toMatchObject({
          description: "harness note",
          revision: "2",
        });
        expect(await mutation).toMatchObject({
          note: "harness note",
          noteRevision: "2",
        });
        await setHarnessEdit(state, false);
        await state.commit();
        stateStarted = false;
        await expectHarnessState(target, "harness note", "2", false);
        await expect(
          albums.updateMediaNote({
            ...noteInput(target),
            expectedRevision: "2",
            note: "denied",
          }),
        ).rejects.toMatchObject({ reason: "FORBIDDEN" });
        await expectHarnessState(target, "harness note", "2", false);
      } finally {
        latch.release();
        await mutation.catch(() => undefined);
        await stateLock?.catch(() => undefined);
        if (stateStarted) await state.rollback();
        await setHarnessEdit(state, true);
        state.release();
      }
    });

    it("keeps ordinary construction independent of another instance's rejecting hook", async () => {
      const target = await harnessMedia();
      const failure = new Error("TEST_INSTANCE_HOOK");
      const hooked = new MySqlAlbumRepository(database.pool, {
        testHook: () => {
          throw failure;
        },
      });
      await expect(hooked.updateMediaNote(noteInput(target))).rejects.toBe(
        failure,
      );
      const ordinary = new MySqlAlbumRepository(database.pool);
      await expect(
        ordinary.updateMediaNote(noteInput(target)),
      ).resolves.toMatchObject({
        note: "harness note",
        noteRevision: "2",
      });
      await expectHarnessState(target, "harness note", "2", true);
    });

    it.each([
      "FAMILY_LOCK_QUERY_DISPATCHED",
      "MUTATION_APPLIED_BEFORE_COMMIT",
    ] as const)(
      "rolls back hook rejection at %s through the existing transaction path",
      async (stage) => {
        const target = await harnessMedia();
        const failure = new Error("TEST_HOOK_REJECTED");
        const events: AlbumRepositoryTestEvent[] = [];
        const repository = new MySqlAlbumRepository(database.pool, {
          testHook: async (event) => {
            events.push(event);
            if (event.stage === stage) throw failure;
          },
        });
        await expect(
          repository.updateMediaNote(noteInput(target)),
        ).rejects.toBe(failure);
        expect(events.filter((event) => event.stage === stage)).toHaveLength(1);
        await expectHarnessState(target, null, "1", true);
        // Also proves rollback released the lock and did not consume revision 1.
        await expect(
          albums.updateMediaNote(noteInput(target)),
        ).resolves.toMatchObject({ noteRevision: "2" });
      },
    );

    it("emits both stages only for the six designated mutations", async () => {
      const target = await harnessMedia();
      const events: AlbumRepositoryTestEvent[] = [];
      const repository = new MySqlAlbumRepository(database.pool, {
        testHook: (event) => {
          events.push(event);
        },
      });
      const input = { actor: actor(editor), albumId: albumA, mediaId: target };
      const tag = await repository.createAndApplyMediaTag({
        ...input,
        name: "Harness",
        normalizedName: Buffer.from("harness"),
      });
      await repository.applyMediaTag({ ...input, tagId: tag.id });
      await repository.removeMediaTag({ ...input, tagId: tag.id });
      await repository.updateMediaNote(noteInput(target));
      const comment = await repository.createMediaComment({
        ...input,
        body: "harness",
        admit: () => undefined,
      });
      await repository.deleteMediaComment({ ...input, commentId: comment.id });
      const operations = [
        "TAG_CREATE_APPLY",
        "TAG_APPLY_EXISTING",
        "TAG_REMOVE",
        "NOTE_UPDATE",
        "COMMENT_CREATE",
        "COMMENT_DELETE",
      ];
      expect(events).toEqual(
        operations.flatMap((operation) => [
          { stage: "FAMILY_LOCK_QUERY_DISPATCHED", operation, familyId },
          { stage: "MUTATION_APPLIED_BEFORE_COMMIT", operation, familyId },
        ]),
      );
      await repository.getAlbumMedia(input);
      await repository.listMediaTags(input);
      await repository.listMediaComments({ ...input, limit: 20 });
      expect(events).toHaveLength(12);
    });
  });

  async function harnessMedia() {
    const connection = await database.pool.getConnection();
    try {
      const id = await insertMedia(connection, familyId, owner.memberId);
      await connection.query(
        "INSERT INTO album_media (family_id,album_id,media_id) VALUES (?,?,?)",
        [familyId, albumA, id],
      );
      return id;
    } finally {
      connection.release();
    }
  }

  function noteInput(target: string) {
    return {
      actor: actor(editor),
      albumId: albumA,
      mediaId: target,
      note: "harness note",
      expectedRevision: "1",
    };
  }

  type QueryExecutor = Pick<PoolConnection, "query"> | Pick<Pool, "query">;

  async function stateFirst<T>(
    operation: AlbumRepositoryTestOperation,
    run: (repository: MySqlAlbumRepository) => Promise<T>,
    changeState: (connection: PoolConnection) => Promise<void>,
  ) {
    const latch = albumRaceBarrier({
      operation,
      stage: "FAMILY_LOCK_QUERY_DISPATCHED",
    });
    const repository = new MySqlAlbumRepository(database.pool, {
      testHook: latch.hook,
    });
    const connection = await database.pool.getConnection();
    let committed = false;
    let pending: Promise<T | unknown> | undefined;
    try {
      await connection.beginTransaction();
      await connection.query("SELECT id FROM families WHERE id=? FOR UPDATE", [
        familyId,
      ]);
      await changeState(connection);
      pending = run(repository).then(
        (value) => value,
        (error: unknown) => error,
      );
      expect(await latch.wait()).toMatchObject({ operation, familyId });
      await connection.commit();
      committed = true;
      return await pending;
    } finally {
      latch.release();
      if (!committed) await connection.rollback();
      await pending;
      connection.release();
    }
  }

  async function mutationFirst<T>(
    operation: AlbumRepositoryTestOperation,
    run: (repository: MySqlAlbumRepository) => Promise<T>,
    changeState: (connection: PoolConnection) => Promise<void>,
  ) {
    const latch = albumRaceBarrier(
      { operation, stage: "MUTATION_APPLIED_BEFORE_COMMIT" },
      { pause: true },
    );
    const repository = new MySqlAlbumRepository(database.pool, {
      testHook: latch.hook,
    });
    const mutation = run(repository);
    void mutation.catch(() => undefined);
    const connection = await database.pool.getConnection();
    let transactionStarted = false;
    let stateLock: Promise<unknown> | undefined;
    try {
      expect(await latch.wait()).toMatchObject({ operation, familyId });
      await connection.beginTransaction();
      transactionStarted = true;
      stateLock = connection.query(
        "SELECT id FROM families WHERE id=? FOR UPDATE",
        [familyId],
      );
      void stateLock.catch(() => undefined);
      latch.release();
      await stateLock;
      const result = await mutation;
      await changeState(connection);
      await connection.commit();
      transactionStarted = false;
      return result;
    } finally {
      latch.release();
      await mutation.catch(() => undefined);
      await stateLock?.catch(() => undefined);
      if (transactionStarted) await connection.rollback();
      connection.release();
    }
  }

  async function visibleRaceTag(label: string) {
    const normalized = normalizeTagName(`race-${label}-${suffix}`);
    return albums.createAndApplyMediaTag({
      actor: actor(editor),
      albumId: albumA,
      mediaId,
      name: normalized.name,
      normalizedName: normalized.normalizedBytes,
    });
  }

  function tagInput(target: string, tagId: string) {
    return { actor: actor(editor), albumId: albumA, mediaId: target, tagId };
  }

  function createTagInput(target: string, input: string) {
    const normalized = normalizeTagName(input);
    return {
      actor: actor(editor),
      albumId: albumA,
      mediaId: target,
      name: normalized.name,
      normalizedName: normalized.normalizedBytes,
    };
  }

  function commentInput(target: string, body: string) {
    return {
      actor: actor(viewer),
      albumId: albumA,
      mediaId: target,
      body,
      admit: () => undefined,
    };
  }

  async function tagRelationCount(target: string, tagId: string) {
    const [rows] = await database.pool.query<RowDataPacket[]>(
      "SELECT COUNT(*) AS count FROM media_tags WHERE family_id=? AND media_id=? AND tag_id=?",
      [familyId, target, tagId],
    );
    return String(rows[0]?.count);
  }

  async function tagIdentityCount(name: string) {
    const normalized = normalizeTagName(name);
    const [rows] = await database.pool.query<RowDataPacket[]>(
      "SELECT COUNT(*) AS count FROM tags WHERE family_id=? AND name_normalized=?",
      [familyId, normalized.normalizedBytes],
    );
    return String(rows[0]?.count);
  }

  async function commentCount(target: string) {
    const [rows] = await database.pool.query<RowDataPacket[]>(
      "SELECT COUNT(*) AS count FROM comments WHERE family_id=? AND media_id=?",
      [familyId, target],
    );
    return String(rows[0]?.count);
  }

  async function setHarnessView(
    connection: QueryExecutor,
    memberId: string,
    enabled: boolean,
  ) {
    await connection.query(
      "UPDATE album_members SET can_view=?,can_edit=IF(?=0,0,can_edit) WHERE family_id=? AND album_id=? AND member_id=?",
      [enabled, enabled, familyId, albumA, memberId],
    );
  }

  async function setMemberLifecycle(
    connection: QueryExecutor,
    memberId: string,
    field: "disabled_at" | "left_at",
    inactive: boolean,
  ) {
    const sql =
      field === "disabled_at"
        ? "UPDATE family_members SET disabled_at=IF(?=1,CURRENT_TIMESTAMP(3),NULL) WHERE family_id=? AND id=?"
        : "UPDATE family_members SET left_at=IF(?=1,CURRENT_TIMESTAMP(3),NULL) WHERE family_id=? AND id=?";
    await connection.query(sql, [inactive, familyId, memberId]);
  }

  async function removeHarnessPlacement(
    connection: QueryExecutor,
    target: string,
  ) {
    await connection.query(
      "DELETE FROM album_media WHERE family_id=? AND album_id=? AND media_id=?",
      [familyId, albumA, target],
    );
  }

  async function restoreHarnessPlacement(target: string) {
    await database.pool.query(
      "INSERT IGNORE INTO album_media (family_id,album_id,media_id) VALUES (?,?,?)",
      [familyId, albumA, target],
    );
  }

  async function expectMediaVisible(
    target: string,
    expected: boolean,
    identityValue: TestIdentity = editor,
  ) {
    const operation = albums.getAlbumMedia({
      actor: actor(identityValue),
      albumId: albumA,
      mediaId: target,
    });
    if (expected)
      await expect(operation).resolves.toMatchObject({ mediaId: target });
    else await expect(operation).rejects.toBeInstanceOf(AlbumRepositoryError);
  }

  async function expectMediaRow(
    target: string,
    note: string | null,
    revision: string,
  ) {
    const [rows] = await database.pool.query<RowDataPacket[]>(
      "SELECT description, CAST(note_revision AS CHAR) AS revision FROM media_items WHERE family_id=? AND id=?",
      [familyId, target],
    );
    expect(rows[0]).toMatchObject({ description: note, revision });
  }

  async function setHarnessEdit(connection: QueryExecutor, enabled: boolean) {
    await connection.query(
      "UPDATE album_members SET can_edit=? WHERE family_id=? AND album_id=? AND member_id=?",
      [enabled, familyId, albumA, editor.memberId],
    );
  }

  async function expectHarnessState(
    target: string,
    note: string | null,
    revision: string,
    canEdit: boolean,
  ) {
    const detail = await albums.getAlbumMedia({
      actor: actor(editor),
      albumId: albumA,
      mediaId: target,
    });
    expect(detail).toMatchObject({
      note,
      noteRevision: revision,
      capabilities: { canEditNote: canEdit },
    });
    const [rows] = await database.pool.query<RowDataPacket[]>(
      "SELECT can_edit AS canEdit, can_view AS canView FROM album_members WHERE family_id=? AND album_id=? AND member_id=?",
      [familyId, albumA, editor.memberId],
    );
    expect(rows[0]).toMatchObject({ canEdit: Number(canEdit), canView: 1 });
  }

  async function preservationMedia() {
    const target = await harnessMedia();
    await database.pool.query(
      `UPDATE media_items SET media_type='IMAGE',detected_mime='image/jpeg',
         processing_state='PENDING',metadata_generation=1,
         raw_width=120,raw_height=80,display_width=80,display_height=120,
         orientation=6,is_animated=0,motion_hint=0,
         captured_local_at='2025-01-02 03:04:05.123',
         captured_at_utc='2025-01-02 00:34:05.123',captured_offset_minutes=150,
         captured_source='EXIF_ORIGINAL',captured_time_status='OFFSET_KNOWN',
         timeline_key='2025-01-02 03:04:05.123',timeline_basis='CAPTURE_LOCAL',
         gps_latitude='0.000000',gps_longitude='180.000000',
         camera_make='Synthetic',camera_model='Fixture',warning_flags=3
       WHERE family_id=? AND id=?`,
      [familyId, target],
    );
    await database.pool.query(
      "INSERT INTO album_media (family_id,album_id,media_id) VALUES (?,?,?)",
      [familyId, albumB, target],
    );
    const [job] = await database.pool.query<ResultSetHeader>(
      `INSERT INTO background_jobs
        (family_id,media_id,generation,recipe_id,job_type,state,available_at)
       VALUES (?,?,1,1,'IMAGE_DERIVATIVES','QUEUED',CURRENT_TIMESTAMP(3))`,
      [familyId, target],
    );
    await database.pool.query(
      `INSERT INTO derived_assets
        (family_id,media_id,generation,recipe_id,kind,state,reserved_bytes,producer_job_id)
       VALUES (?,?,1,1,'THUMBNAIL','RESERVED',256,?)`,
      [familyId, target, String(job.insertId)],
    );
    return target;
  }

  async function preservationSnapshot(target: string) {
    const [mediaRows] = await database.pool.query<RowDataPacket[]>(
      `SELECT CAST(id AS CHAR) AS id,CAST(family_id AS CHAR) AS familyId,
        CAST(storage_object_id AS CHAR) AS storageObjectId,
        CAST(source_upload_id AS CHAR) AS sourceUploadId,
        DATE_FORMAT(uploaded_at,'%Y-%m-%d %H:%i:%s.%f') AS uploadedAt,
        media_type AS mediaType,detected_mime AS detectedMime,
        processing_state AS processingState,CAST(generation AS CHAR) AS generation,
        recipe_id AS recipeId,CAST(metadata_generation AS CHAR) AS metadataGeneration,
        raw_width AS rawWidth,raw_height AS rawHeight,display_width AS displayWidth,
        display_height AS displayHeight,CAST(duration_ms AS CHAR) AS durationMs,
        orientation,video_rotation_degrees AS videoRotationDegrees,
        is_animated+0 AS isAnimated,motion_hint+0 AS motionHint,
        DATE_FORMAT(captured_local_at,'%Y-%m-%d %H:%i:%s.%f') AS capturedLocalAt,
        DATE_FORMAT(captured_at_utc,'%Y-%m-%d %H:%i:%s.%f') AS capturedAtUtc,
        captured_offset_minutes AS capturedOffsetMinutes,captured_source AS capturedSource,
        captured_time_status AS capturedTimeStatus,
        DATE_FORMAT(timeline_key,'%Y-%m-%d %H:%i:%s.%f') AS timelineKey,
        timeline_basis AS timelineBasis,gps_latitude AS gpsLatitude,
        gps_longitude AS gpsLongitude,camera_make AS cameraMake,camera_model AS cameraModel,
        video_codec AS videoCodec,video_container AS videoContainer,
        video_transfer AS videoTransfer,CAST(warning_flags AS CHAR) AS warningFlags,
        last_failure_code AS lastFailureCode,description,
        CAST(note_revision AS CHAR) AS noteRevision
       FROM media_items WHERE family_id=? AND id=?`,
      [familyId, target],
    );
    const [storageRows] = await database.pool.query<RowDataPacket[]>(
      `SELECT CAST(id AS CHAR) AS id,CAST(family_id AS CHAR) AS familyId,
        HEX(sha256) AS sha256,CAST(byte_size AS CHAR) AS byteSize,
        key_version AS keyVersion,state,
        DATE_FORMAT(durable_at,'%Y-%m-%d %H:%i:%s.%f') AS durableAt,
        DATE_FORMAT(verified_at,'%Y-%m-%d %H:%i:%s.%f') AS verifiedAt
       FROM storage_objects WHERE family_id=? AND id=?`,
      [familyId, String(mediaRows[0]?.storageObjectId)],
    );
    const [placements] = await database.pool.query<RowDataPacket[]>(
      `SELECT CAST(id AS CHAR) AS id,CAST(family_id AS CHAR) AS familyId,
        CAST(album_id AS CHAR) AS albumId,CAST(media_id AS CHAR) AS mediaId,
        DATE_FORMAT(created_at,'%Y-%m-%d %H:%i:%s.%f') AS createdAt
       FROM album_media WHERE family_id=? AND media_id=? ORDER BY album_id,id`,
      [familyId, target],
    );
    const [derived] = await database.pool.query<RowDataPacket[]>(
      `SELECT CAST(id AS CHAR) AS id,CAST(family_id AS CHAR) AS familyId,
        CAST(media_id AS CHAR) AS mediaId,CAST(generation AS CHAR) AS generation,
        recipe_id AS recipeId,kind,state,CAST(reserved_bytes AS CHAR) AS reservedBytes,
        CAST(byte_size AS CHAR) AS byteSize,HEX(sha256) AS sha256,width,height,
        output_mime AS outputMime,CAST(producer_job_id AS CHAR) AS producerJobId,
        CAST(producer_lease_epoch AS CHAR) AS producerLeaseEpoch,failure_code AS failureCode,
        DATE_FORMAT(published_at,'%Y-%m-%d %H:%i:%s.%f') AS publishedAt,
        DATE_FORMAT(cleaned_at,'%Y-%m-%d %H:%i:%s.%f') AS cleanedAt
       FROM derived_assets WHERE family_id=? AND media_id=?
       ORDER BY generation,recipe_id,kind,id`,
      [familyId, target],
    );
    return {
      media: mediaRows[0],
      storage: storageRows[0],
      placements,
      derived,
    };
  }
});

type TestIdentity = {
  userId: string;
  memberId: string;
  sessionId: string;
  tokenHash: Buffer;
};

function identity(): TestIdentity {
  return {
    userId: "",
    memberId: "",
    sessionId: "",
    tokenHash: Buffer.alloc(32),
  };
}

function actor(value: TestIdentity) {
  return {
    userId: value.userId,
    sessionId: value.sessionId,
    tokenHash: value.tokenHash,
  };
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
    throw new Error("PHASE6C_DEV_PREFLIGHT_FAILED");
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
): Promise<TestIdentity> {
  const username = `p6c_${label}_${suffix}`;
  const [user] = await connection.query<ResultSetHeader>(
    `INSERT INTO users
      (username,username_normalized,password_hash,display_name,password_changed_at)
     VALUES (?,?,?,?,CURRENT_TIMESTAMP(3))`,
    [username, Buffer.from(username), "synthetic-not-used", `P6C ${label}`],
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

async function putGrant(
  connection: PoolConnection,
  familyId: string,
  albumId: string,
  memberId: string,
  canEdit: boolean,
) {
  await connection.query(
    `INSERT INTO album_members (family_id,album_id,member_id,can_view,can_edit)
     VALUES (?,?,?,1,?)`,
    [familyId, albumId, memberId, canEdit],
  );
}

async function insertMedia(
  connection: PoolConnection,
  familyId: string,
  memberId: string,
) {
  const sha = randomBytes(32);
  const [object] = await connection.query<ResultSetHeader>(
    `INSERT INTO storage_objects
      (family_id,sha256,byte_size,key_version,state,durable_at,verified_at)
     VALUES (?,?,8,1,'AVAILABLE',CURRENT_TIMESTAMP(3),CURRENT_TIMESTAMP(3))`,
    [familyId, sha],
  );
  const [upload] = await connection.query<ResultSetHeader>(
    `INSERT INTO upload_sessions
      (public_id,family_id,created_by_member_id,original_filename,declared_size,
       committed_offset,state,computed_sha256,finalize_started_at,storage_object_id,
       completed_at,expires_at)
     VALUES (?,?,?,'synthetic.png',8,8,'COMPLETE',?,CURRENT_TIMESTAMP(3),?,
       CURRENT_TIMESTAMP(3),DATE_ADD(CURRENT_TIMESTAMP(3),INTERVAL 1 DAY))`,
    [randomBytes(16), familyId, memberId, sha, String(object.insertId)],
  );
  const [media] = await connection.query<ResultSetHeader>(
    `INSERT INTO media_items
      (family_id,storage_object_id,source_upload_id,uploaded_at,timeline_key)
     VALUES (?,?,?,CURRENT_TIMESTAMP(3),CURRENT_TIMESTAMP(3))`,
    [familyId, String(object.insertId), String(upload.insertId)],
  );
  return String(media.insertId);
}

async function insertTag(
  connection: PoolConnection,
  familyId: string,
  name: string,
  normalized: string,
) {
  const [tag] = await connection.query<ResultSetHeader>(
    "INSERT INTO tags (family_id,name,name_normalized) VALUES (?,?,?)",
    [familyId, name, Buffer.from(normalized)],
  );
  return String(tag.insertId);
}
