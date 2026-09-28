import { randomBytes, randomUUID } from "node:crypto";

import type {
  Pool,
  PoolConnection,
  ResultSetHeader,
  RowDataPacket,
} from "mysql2/promise";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  assertMigrationReadiness,
  createDatabase,
  isApprovedIdentityDuplicate,
  MySqlAlbumRepository,
  MySqlDerivedReadRepository,
  runCheckedTransaction,
} from "../../packages/db/src/index.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("PHASE6B_DEV_DATABASE_URL_REQUIRED");

describe.sequential("Phase 6B favorites and family featured", () => {
  const database = createDatabase(databaseUrl);
  const albums = new MySqlAlbumRepository(database.pool);
  const derived = new MySqlDerivedReadRepository(database.pool);
  const suffix = randomUUID().replaceAll("-", "");
  let familyId = "";
  let otherFamilyId = "";
  let admin = identity();
  let viewer = identity();
  let superAdmin = identity();
  let hiddenOwner = identity();
  let outsider = identity();
  let albumA = "";
  let albumB = "";
  let hiddenAlbum = "";
  let mediaId = "";
  let unplacedMediaId = "";

  beforeAll(async () => {
    const connection = await database.pool.getConnection();
    try {
      await preflight(connection);
      familyId = await insertFamily(connection, `Phase 6B ${suffix}`);
      otherFamilyId = await insertFamily(
        connection,
        `Phase 6B other ${suffix}`,
      );
      superAdmin = await insertIdentity(
        connection,
        familyId,
        suffix,
        "super",
        "SUPER_ADMIN",
      );
      admin = await insertIdentity(
        connection,
        familyId,
        suffix,
        "admin",
        "ADMIN",
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
      albumA = await insertAlbum(
        connection,
        familyId,
        admin.memberId,
        "Admin album",
      );
      albumB = await insertAlbum(
        connection,
        familyId,
        viewer.memberId,
        "Viewer album",
      );
      hiddenAlbum = await insertAlbum(
        connection,
        familyId,
        hiddenOwner.memberId,
        "Hidden album",
      );
      await putViewGrant(connection, familyId, albumA, viewer.memberId, true);
      await putViewGrant(
        connection,
        familyId,
        albumA,
        superAdmin.memberId,
        true,
      );
      mediaId = await insertMedia(connection, familyId, admin.memberId);
      unplacedMediaId = await insertMedia(connection, familyId, admin.memberId);
      await insertReadyDerived(connection, familyId, mediaId);
      await connection.query(
        `INSERT INTO album_media (family_id, album_id, media_id)
         VALUES (?,?,?),(?,?,?),(?,?,?)`,
        [
          familyId,
          albumA,
          mediaId,
          familyId,
          albumB,
          mediaId,
          familyId,
          hiddenAlbum,
          mediaId,
        ],
      );
    } finally {
      connection.release();
    }
  });

  afterAll(async () => {
    for (const id of [familyId, otherFamilyId].filter(Boolean)) {
      await database.pool.query(
        "DELETE FROM user_favorites WHERE family_id = ?",
        [id],
      );
      await database.pool.query(
        "DELETE FROM family_featured WHERE family_id = ?",
        [id],
      );
      await database.pool.query(
        "DELETE FROM derived_assets WHERE family_id = ?",
        [id],
      );
      await database.pool.query(
        "DELETE FROM background_jobs WHERE family_id = ?",
        [id],
      );
      await database.pool.query("DELETE FROM album_media WHERE family_id = ?", [
        id,
      ]);
      await database.pool.query(
        "DELETE FROM album_members WHERE family_id = ?",
        [id],
      );
      await database.pool.query("DELETE FROM media_items WHERE family_id = ?", [
        id,
      ]);
      await database.pool.query(
        "DELETE FROM upload_sessions WHERE family_id = ?",
        [id],
      );
      await database.pool.query(
        "DELETE FROM storage_objects WHERE family_id = ?",
        [id],
      );
      await database.pool.query("DELETE FROM albums WHERE family_id = ?", [id]);
      await database.pool.query(
        "DELETE s FROM sessions s JOIN family_members m ON m.user_id=s.user_id WHERE m.family_id = ?",
        [id],
      );
      const [userRows] = await database.pool.query<RowDataPacket[]>(
        "SELECT CAST(user_id AS CHAR) AS userId FROM family_members WHERE family_id = ?",
        [id],
      );
      await database.pool.query(
        "DELETE FROM family_members WHERE family_id = ?",
        [id],
      );
      for (const row of userRows) {
        await database.pool.query("DELETE FROM users WHERE id = ?", [
          String(row.userId),
        ]);
      }
      await database.pool.query("DELETE FROM families WHERE id = ?", [id]);
    }
    await database.pool.end();
  });

  it("keeps private flags media-level, idempotent, and identical across albums", async () => {
    expect(
      await albums.putFavorite({
        actor: actor(viewer),
        albumId: albumA,
        mediaId,
      }),
    ).toMatchObject({ isFavorite: true });
    const [favoriteBefore] = await favoriteRows(viewer.memberId);
    expect(
      await albums.putFavorite({
        actor: actor(viewer),
        albumId: albumA,
        mediaId,
      }),
    ).toMatchObject({ isFavorite: true });
    const [favoriteAfter] = await favoriteRows(viewer.memberId);
    expect(favoriteAfter?.createdAt).toEqual(favoriteBefore?.createdAt);

    expect(
      await albums.putFeatured({
        actor: actor(admin),
        albumId: albumA,
        mediaId,
      }),
    ).toMatchObject({ isFamilyFeatured: true });
    const [featuredBefore] = await featuredRows();
    expect(
      await albums.putFeatured({
        actor: actor(superAdmin),
        albumId: albumA,
        mediaId,
      }),
    ).toMatchObject({ isFamilyFeatured: true });
    const [featuredAfter] = await featuredRows();
    expect(featuredAfter).toMatchObject({
      featuredByMemberId: admin.memberId,
      createdAt: featuredBefore?.createdAt,
    });

    const throughA = await albums.getAlbumMedia({
      actor: actor(viewer),
      albumId: albumA,
      mediaId,
    });
    const throughB = await albums.getAlbumMedia({
      actor: actor(viewer),
      albumId: albumB,
      mediaId,
    });
    expect(throughA).toMatchObject({
      isFavorite: true,
      isFamilyFeatured: true,
    });
    expect(throughB).toMatchObject({
      isFavorite: true,
      isFamilyFeatured: true,
    });
    const timeline = await albums.listFamilyTimeline({
      actor: actor(viewer),
      familyId,
      limit: 20,
    });
    expect(timeline).toHaveLength(1);
    expect(timeline[0]).toMatchObject({
      mediaId,
      isFavorite: true,
      isFamilyFeatured: true,
    });
  });

  it("classifies the exact key emitted by mysql2 and retains identity verification", async () => {
    await albums.putFavorite({
      actor: actor(viewer),
      albumId: albumB,
      mediaId,
    });
    let duplicate: unknown;
    try {
      await database.pool.query(
        `INSERT INTO user_favorites (family_id, member_id, media_id)
         VALUES (?, ?, ?)`,
        [familyId, viewer.memberId, mediaId],
      );
    } catch (error) {
      duplicate = error;
    }
    expect(duplicate).toMatchObject({
      code: "ER_DUP_ENTRY",
      errno: 1062,
      sqlState: "23000",
    });
    expect(
      isApprovedIdentityDuplicate(duplicate, "uq_user_favorites_identity"),
    ).toBe(true);
    expect(await favoriteRows(viewer.memberId)).toHaveLength(1);
  });

  it("requires current visibility before exposing or mutating state", async () => {
    await setViewGrant(false);
    await expect(
      albums.getAlbumMedia({ actor: actor(viewer), albumId: albumA, mediaId }),
    ).rejects.toMatchObject({ reason: "NOT_FOUND" });
    await expect(
      albums.putFavorite({ actor: actor(viewer), albumId: albumA, mediaId }),
    ).rejects.toMatchObject({ reason: "NOT_FOUND" });
    await expect(
      albums.deleteFavorite({ actor: actor(viewer), albumId: albumA, mediaId }),
    ).rejects.toMatchObject({ reason: "NOT_FOUND" });
    const throughB = await albums.getAlbumMedia({
      actor: actor(viewer),
      albumId: albumB,
      mediaId,
    });
    expect(throughB.isFavorite).toBe(true);
    await setViewGrant(true);
    expect(
      (
        await albums.getAlbumMedia({
          actor: actor(viewer),
          albumId: albumA,
          mediaId,
        })
      ).isFavorite,
    ).toBe(true);
  });

  it("keeps a favorite dormant after all visibility is lost and restores it with access", async () => {
    await albums.putFavorite({
      actor: actor(viewer),
      albumId: albumB,
      mediaId,
    });
    await setViewGrant(false);
    await albums.removeAlbumMedia({
      actor: actor(viewer),
      albumId: albumB,
      mediaId,
    });
    for (const albumId of [albumA, albumB]) {
      await expect(
        albums.getAlbumMedia({ actor: actor(viewer), albumId, mediaId }),
      ).rejects.toMatchObject({ reason: "NOT_FOUND" });
      await expect(
        albums.putFavorite({ actor: actor(viewer), albumId, mediaId }),
      ).rejects.toMatchObject({ reason: "NOT_FOUND" });
      await expect(
        albums.deleteFavorite({ actor: actor(viewer), albumId, mediaId }),
      ).rejects.toMatchObject({ reason: "NOT_FOUND" });
    }
    for (const kind of ["THUMBNAIL", "PREVIEW"] as const) {
      await expect(
        derived.findViewableReadyDerived({
          userId: viewer.userId,
          mediaId,
          kind,
        }),
      ).resolves.toBeNull();
    }
    expect(await favoriteRows(viewer.memberId)).toHaveLength(1);
    await albums.addAlbumMedia({
      actor: actor(viewer),
      albumId: albumB,
      mediaId,
    });
    expect(
      (
        await albums.getAlbumMedia({
          actor: actor(viewer),
          albumId: albumB,
          mediaId,
        })
      ).isFavorite,
    ).toBe(true);
    await setViewGrant(true);
  });

  it("enforces featured role without ADMIN or SUPER_ADMIN ACL bypass", async () => {
    await expect(
      albums.putFeatured({ actor: actor(viewer), albumId: albumB, mediaId }),
    ).rejects.toMatchObject({ reason: "FORBIDDEN" });
    for (const identity of [admin, superAdmin]) {
      await expect(
        albums.putFeatured({
          actor: actor(identity),
          albumId: hiddenAlbum,
          mediaId,
        }),
      ).rejects.toMatchObject({ reason: "NOT_FOUND" });
    }
    await expect(
      albums.putFeatured({ actor: actor(outsider), albumId: albumA, mediaId }),
    ).rejects.toMatchObject({ reason: "NOT_FOUND" });
    await expect(
      albums.putFavorite({ actor: actor(outsider), albumId: albumA, mediaId }),
    ).rejects.toMatchObject({ reason: "NOT_FOUND" });
    await expect(
      albums.putFavorite({
        actor: actor(superAdmin),
        albumId: hiddenAlbum,
        mediaId,
      }),
    ).rejects.toMatchObject({ reason: "NOT_FOUND" });
    await expect(
      albums.putFavorite({
        actor: actor(admin),
        albumId: albumA,
        mediaId: unplacedMediaId,
      }),
    ).rejects.toMatchObject({ reason: "NOT_FOUND" });
  });

  it("keeps gallery enrichment query count bounded as the page grows", async () => {
    const one = await countQueries((repository) =>
      repository.listAlbumMedia({
        actor: actor(viewer),
        albumId: albumB,
        limit: 100,
      }),
    );
    await albums.addAlbumMedia({
      actor: actor(viewer),
      albumId: albumB,
      mediaId: unplacedMediaId,
    });
    const two = await countQueries((repository) =>
      repository.listAlbumMedia({
        actor: actor(viewer),
        albumId: albumB,
        limit: 100,
      }),
    );
    expect(two.value).toHaveLength(2);
    expect(two.queries).toBe(one.queries);
    await albums.removeAlbumMedia({
      actor: actor(viewer),
      albumId: albumB,
      mediaId: unplacedMediaId,
    });
  });

  it("serializes concurrent PUT/DELETE and preserves first featured actor", async () => {
    await albums.deleteFavorite({
      actor: actor(viewer),
      albumId: albumA,
      mediaId,
    });
    const favoritePuts = await Promise.all([
      albums.putFavorite({ actor: actor(viewer), albumId: albumA, mediaId }),
      albums.putFavorite({ actor: actor(viewer), albumId: albumA, mediaId }),
    ]);
    expect(favoritePuts.map((value) => value.isFavorite)).toEqual([true, true]);
    expect(await favoriteRows(viewer.memberId)).toHaveLength(1);
    const favoriteDeletes = await Promise.all([
      albums.deleteFavorite({ actor: actor(viewer), albumId: albumA, mediaId }),
      albums.deleteFavorite({ actor: actor(viewer), albumId: albumA, mediaId }),
    ]);
    expect(favoriteDeletes.map((value) => value.isFavorite)).toEqual([
      false,
      false,
    ]);
    expect(await favoriteRows(viewer.memberId)).toHaveLength(0);

    await albums.deleteFeatured({
      actor: actor(admin),
      albumId: albumA,
      mediaId,
    });
    const featuredPuts = await Promise.all([
      albums.putFeatured({ actor: actor(admin), albumId: albumA, mediaId }),
      albums.putFeatured({
        actor: actor(superAdmin),
        albumId: albumA,
        mediaId,
      }),
    ]);
    expect(featuredPuts.map((value) => value.isFamilyFeatured)).toEqual([
      true,
      true,
    ]);
    const featured = await featuredRows();
    expect(featured).toHaveLength(1);
    expect([admin.memberId, superAdmin.memberId]).toContain(
      featured[0]?.featuredByMemberId,
    );
    const featuredDeletes = await Promise.all([
      albums.deleteFeatured({ actor: actor(admin), albumId: albumA, mediaId }),
      albums.deleteFeatured({
        actor: actor(superAdmin),
        albumId: albumA,
        mediaId,
      }),
    ]);
    expect(featuredDeletes.map((value) => value.isFamilyFeatured)).toEqual([
      false,
      false,
    ]);
    expect(await featuredRows()).toHaveLength(0);
  });

  it("proves both role-downgrade orderings for featured", async () => {
    await albums.deleteFeatured({
      actor: actor(admin),
      albumId: albumA,
      mediaId,
    });
    await albums.putFeatured({ actor: actor(admin), albumId: albumA, mediaId });
    await setMemberRole(admin.memberId, "MEMBER");
    expect(await featuredRows()).toMatchObject([
      { featuredByMemberId: admin.memberId },
    ]);
    await expect(
      albums.deleteFeatured({ actor: actor(admin), albumId: albumA, mediaId }),
    ).rejects.toMatchObject({ reason: "FORBIDDEN" });
    await setMemberRole(admin.memberId, "ADMIN");
    await albums.deleteFeatured({
      actor: actor(admin),
      albumId: albumA,
      mediaId,
    });

    const denied = commitStateBefore(
      (connection) => setMemberRoleOn(connection, admin.memberId, "MEMBER"),
      () =>
        albums.putFeatured({ actor: actor(admin), albumId: albumA, mediaId }),
    );
    await expect(denied).rejects.toMatchObject({ reason: "FORBIDDEN" });
    expect(await featuredRows()).toHaveLength(0);
    await setMemberRole(admin.memberId, "ADMIN");
  });

  it.each(["disabled_at", "left_at"] as const)(
    "proves both favorite lifecycle orderings for %s",
    async (column) => {
      await albums.deleteFavorite({
        actor: actor(viewer),
        albumId: albumB,
        mediaId,
      });
      await albums.putFavorite({
        actor: actor(viewer),
        albumId: albumB,
        mediaId,
      });
      await setMemberLifecycle(viewer.memberId, column, true);
      expect(await favoriteRows(viewer.memberId)).toHaveLength(1);
      await expect(
        albums.putFavorite({ actor: actor(viewer), albumId: albumB, mediaId }),
      ).rejects.toMatchObject({ reason: "UNAUTHENTICATED" });
      await setMemberLifecycle(viewer.memberId, column, false);
      await albums.deleteFavorite({
        actor: actor(viewer),
        albumId: albumB,
        mediaId,
      });

      const denied = commitStateBefore(
        (connection) =>
          setMemberLifecycleOn(connection, viewer.memberId, column, true),
        () =>
          albums.putFavorite({
            actor: actor(viewer),
            albumId: albumB,
            mediaId,
          }),
      );
      await expect(denied).rejects.toMatchObject({ reason: "UNAUTHENTICATED" });
      expect(await favoriteRows(viewer.memberId)).toHaveLength(0);
      await setMemberLifecycle(viewer.memberId, column, false);
    },
  );

  it.each(["disabled_at", "left_at"] as const)(
    "proves both featured lifecycle orderings for %s",
    async (column) => {
      await albums.deleteFeatured({
        actor: actor(admin),
        albumId: albumA,
        mediaId,
      });
      await albums.putFeatured({
        actor: actor(admin),
        albumId: albumA,
        mediaId,
      });
      await setMemberLifecycle(admin.memberId, column, true);
      expect(await featuredRows()).toMatchObject([
        { featuredByMemberId: admin.memberId },
      ]);
      await expect(
        albums.deleteFeatured({
          actor: actor(admin),
          albumId: albumA,
          mediaId,
        }),
      ).rejects.toMatchObject({ reason: "UNAUTHENTICATED" });
      await setMemberLifecycle(admin.memberId, column, false);
      await albums.deleteFeatured({
        actor: actor(admin),
        albumId: albumA,
        mediaId,
      });

      const denied = commitStateBefore(
        (connection) =>
          setMemberLifecycleOn(connection, admin.memberId, column, true),
        () =>
          albums.putFeatured({ actor: actor(admin), albumId: albumA, mediaId }),
      );
      await expect(denied).rejects.toMatchObject({ reason: "UNAUTHENTICATED" });
      expect(await featuredRows()).toHaveLength(0);
      await setMemberLifecycle(admin.memberId, column, false);
    },
  );

  it("proves both favorite ACL orderings", async () => {
    await albums.deleteFavorite({
      actor: actor(viewer),
      albumId: albumA,
      mediaId,
    });
    await albums.putFavorite({
      actor: actor(viewer),
      albumId: albumA,
      mediaId,
    });
    await setViewGrant(false);
    await expect(
      albums.getAlbumMedia({ actor: actor(viewer), albumId: albumA, mediaId }),
    ).rejects.toMatchObject({ reason: "NOT_FOUND" });
    expect(await favoriteRows(viewer.memberId)).toHaveLength(1);
    await setViewGrant(true);
    await albums.deleteFavorite({
      actor: actor(viewer),
      albumId: albumA,
      mediaId,
    });

    const denied = commitStateBefore(
      (connection) => setViewGrantOn(connection, viewer.memberId, false),
      () =>
        albums.putFavorite({ actor: actor(viewer), albumId: albumA, mediaId }),
    );
    await expect(denied).rejects.toMatchObject({ reason: "NOT_FOUND" });
    expect(await favoriteRows(viewer.memberId)).toHaveLength(0);
    await setViewGrant(true);
  });

  it("proves both favorite placement orderings", async () => {
    await albums.putFavorite({
      actor: actor(viewer),
      albumId: albumA,
      mediaId,
    });
    await albums.removeAlbumMedia({
      actor: actor(admin),
      albumId: albumA,
      mediaId,
    });
    await expect(
      albums.putFavorite({ actor: actor(viewer), albumId: albumA, mediaId }),
    ).rejects.toMatchObject({ reason: "NOT_FOUND" });
    expect(await favoriteRows(viewer.memberId)).toHaveLength(1);
    await albums.addAlbumMedia({
      actor: actor(admin),
      albumId: albumA,
      mediaId,
    });
    await albums.deleteFavorite({
      actor: actor(viewer),
      albumId: albumA,
      mediaId,
    });

    const denied = commitStateBefore(
      (connection) => removePlacementOn(connection, albumA),
      () =>
        albums.putFavorite({ actor: actor(viewer), albumId: albumA, mediaId }),
    );
    await expect(denied).rejects.toMatchObject({ reason: "NOT_FOUND" });
    expect(await favoriteRows(viewer.memberId)).toHaveLength(0);
    await albums.addAlbumMedia({
      actor: actor(admin),
      albumId: albumA,
      mediaId,
    });
  });

  it("proves both featured ACL orderings without role bypass", async () => {
    await albums.deleteFeatured({
      actor: actor(admin),
      albumId: albumA,
      mediaId,
    });
    await albums.putFeatured({
      actor: actor(superAdmin),
      albumId: albumA,
      mediaId,
    });
    await setMemberViewGrant(superAdmin.memberId, false);
    await expect(
      albums.putFeatured({
        actor: actor(superAdmin),
        albumId: albumA,
        mediaId,
      }),
    ).rejects.toMatchObject({ reason: "NOT_FOUND" });
    expect(await featuredRows()).toHaveLength(1);
    await setMemberViewGrant(superAdmin.memberId, true);
    await albums.deleteFeatured({
      actor: actor(superAdmin),
      albumId: albumA,
      mediaId,
    });

    const denied = commitStateBefore(
      (connection) => setViewGrantOn(connection, superAdmin.memberId, false),
      () =>
        albums.putFeatured({
          actor: actor(superAdmin),
          albumId: albumA,
          mediaId,
        }),
    );
    await expect(denied).rejects.toMatchObject({ reason: "NOT_FOUND" });
    expect(await featuredRows()).toHaveLength(0);
    await setMemberViewGrant(superAdmin.memberId, true);
  });

  it("proves both featured placement orderings", async () => {
    await albums.putFeatured({ actor: actor(admin), albumId: albumA, mediaId });
    await albums.removeAlbumMedia({
      actor: actor(admin),
      albumId: albumA,
      mediaId,
    });
    await expect(
      albums.putFeatured({ actor: actor(admin), albumId: albumA, mediaId }),
    ).rejects.toMatchObject({ reason: "NOT_FOUND" });
    expect(await featuredRows()).toHaveLength(1);
    await albums.addAlbumMedia({
      actor: actor(admin),
      albumId: albumA,
      mediaId,
    });
    await albums.deleteFeatured({
      actor: actor(admin),
      albumId: albumA,
      mediaId,
    });

    const denied = commitStateBefore(
      (connection) => removePlacementOn(connection, albumA),
      () =>
        albums.putFeatured({ actor: actor(admin), albumId: albumA, mediaId }),
    );
    await expect(denied).rejects.toMatchObject({ reason: "NOT_FOUND" });
    expect(await featuredRows()).toHaveLength(0);
    await albums.addAlbumMedia({
      actor: actor(admin),
      albumId: albumA,
      mediaId,
    });
  });

  it("does not modify canonical media, storage, or placement identity", async () => {
    const before = await preservationSnapshot();
    await albums.putFavorite({
      actor: actor(viewer),
      albumId: albumA,
      mediaId,
    });
    await albums.putFeatured({ actor: actor(admin), albumId: albumA, mediaId });
    await albums.deleteFavorite({
      actor: actor(viewer),
      albumId: albumA,
      mediaId,
    });
    await albums.deleteFeatured({
      actor: actor(admin),
      albumId: albumA,
      mediaId,
    });
    expect(await preservationSnapshot()).toEqual(before);
  });

  async function favoriteRows(memberId: string) {
    const [rows] = await database.pool.query<RowDataPacket[]>(
      `SELECT CAST(id AS CHAR) AS id, created_at AS createdAt
         FROM user_favorites WHERE family_id=? AND member_id=? AND media_id=?`,
      [familyId, memberId, mediaId],
    );
    return rows as Array<{ id: string; createdAt: Date }>;
  }

  async function featuredRows() {
    const [rows] = await database.pool.query<RowDataPacket[]>(
      `SELECT CAST(id AS CHAR) AS id,
              CAST(featured_by_member_id AS CHAR) AS featuredByMemberId,
              created_at AS createdAt
         FROM family_featured WHERE family_id=? AND media_id=?`,
      [familyId, mediaId],
    );
    return rows as Array<{
      id: string;
      featuredByMemberId: string;
      createdAt: Date;
    }>;
  }

  async function preservationSnapshot() {
    const [rows] = await database.pool.query<RowDataPacket[]>(
      `SELECT CAST(m.storage_object_id AS CHAR) AS storageObjectId,
              CAST(m.source_upload_id AS CHAR) AS sourceUploadId,
              CAST(m.generation AS CHAR) AS generation,
              m.processing_state AS processingState,
              HEX(s.sha256) AS sha256Hex,
              CAST(s.byte_size AS CHAR) AS byteSize,
              (SELECT COUNT(*) FROM album_media am
                WHERE am.family_id=m.family_id AND am.media_id=m.id) AS placements,
              (SELECT GROUP_CONCAT(CONCAT(d.id,':',d.generation,':',d.kind,':',
                                          d.state,':',HEX(d.sha256))
                                   ORDER BY d.id SEPARATOR '|')
                 FROM derived_assets d
                WHERE d.family_id=m.family_id AND d.media_id=m.id) AS derivedIdentity
         FROM media_items m
         JOIN storage_objects s
           ON s.family_id=m.family_id AND s.id=m.storage_object_id
        WHERE m.family_id=? AND m.id=?`,
      [familyId, mediaId],
    );
    return rows[0];
  }

  async function setViewGrant(canView: boolean) {
    return setMemberViewGrant(viewer.memberId, canView);
  }

  async function setMemberViewGrant(memberId: string, canView: boolean) {
    await runCheckedTransaction(database.pool, async (connection) => {
      await connection.query("SELECT id FROM families WHERE id=? FOR UPDATE", [
        familyId,
      ]);
      await setViewGrantOn(connection, memberId, canView);
    });
  }

  async function setViewGrantOn(
    connection: PoolConnection,
    memberId: string,
    canView: boolean,
  ) {
    await connection.query(
      `INSERT INTO album_members
        (family_id,album_id,member_id,can_view,updated_at)
       VALUES (?,?,?,?,CURRENT_TIMESTAMP(3))
       ON DUPLICATE KEY UPDATE can_view=VALUES(can_view),
                               updated_at=VALUES(updated_at)`,
      [familyId, albumA, memberId, canView],
    );
  }

  async function setMemberLifecycle(
    memberId: string,
    column: "disabled_at" | "left_at",
    active: boolean,
  ) {
    await runCheckedTransaction(database.pool, async (connection) => {
      await connection.query("SELECT id FROM families WHERE id=? FOR UPDATE", [
        familyId,
      ]);
      await setMemberLifecycleOn(connection, memberId, column, active);
    });
  }

  async function setMemberLifecycleOn(
    connection: PoolConnection,
    memberId: string,
    column: "disabled_at" | "left_at",
    active: boolean,
  ) {
    await connection.query(
      `UPDATE family_members SET ${column}=?, updated_at=CURRENT_TIMESTAMP(3)
        WHERE family_id=? AND id=?`,
      [active ? new Date() : null, familyId, memberId],
    );
  }

  async function setMemberRole(memberId: string, role: "ADMIN" | "MEMBER") {
    await runCheckedTransaction(database.pool, async (connection) => {
      await connection.query("SELECT id FROM families WHERE id=? FOR UPDATE", [
        familyId,
      ]);
      await setMemberRoleOn(connection, memberId, role);
    });
  }

  async function setMemberRoleOn(
    connection: PoolConnection,
    memberId: string,
    role: "ADMIN" | "MEMBER",
  ) {
    await connection.query(
      `UPDATE family_members SET role=?, updated_at=CURRENT_TIMESTAMP(3)
        WHERE family_id=? AND id=?`,
      [role, familyId, memberId],
    );
  }

  async function removePlacementOn(
    connection: PoolConnection,
    targetAlbumId: string,
  ) {
    await connection.query(
      `DELETE FROM album_media
        WHERE family_id=? AND album_id=? AND media_id=?`,
      [familyId, targetAlbumId, mediaId],
    );
  }

  async function commitStateBefore<T>(
    stateChange: (connection: PoolConnection) => Promise<void>,
    blockedOperation: () => Promise<T>,
  ): Promise<T> {
    const connection = await database.pool.getConnection();
    let committed = false;
    try {
      await connection.beginTransaction();
      await connection.query("SELECT id FROM families WHERE id=? FOR UPDATE", [
        familyId,
      ]);
      await stateChange(connection);
      const pending = blockedOperation();
      await new Promise<void>((resolve) => setImmediate(resolve));
      await connection.commit();
      committed = true;
      return await pending;
    } finally {
      if (!committed) await connection.rollback();
      connection.release();
    }
  }

  async function countQueries<T>(
    operation: (repository: MySqlAlbumRepository) => Promise<T>,
  ) {
    let queries = 0;
    const countedPool = {
      async getConnection() {
        const connection = await database.pool.getConnection();
        return new Proxy(connection, {
          get(target, property) {
            if (property === "query") {
              return (...args: Parameters<PoolConnection["query"]>) => {
                queries += 1;
                return target.query(...args);
              };
            }
            const value = Reflect.get(target, property);
            return typeof value === "function" ? value.bind(target) : value;
          },
        });
      },
    } as unknown as Pool;
    const value = await operation(new MySqlAlbumRepository(countedPool));
    return { value, queries };
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
    throw new Error("PHASE6B_DEV_PREFLIGHT_FAILED");
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
  const username = `p6b_${label}_${suffix}`;
  const [user] = await connection.query<ResultSetHeader>(
    `INSERT INTO users
      (username, username_normalized, password_hash, display_name, password_changed_at)
     VALUES (?,?,?,?,CURRENT_TIMESTAMP(3))`,
    [username, Buffer.from(username), "synthetic-not-used", `P6B ${label}`],
  );
  const [member] = await connection.query<ResultSetHeader>(
    "INSERT INTO family_members (family_id,user_id,role) VALUES (?,?,?)",
    [familyId, String(user.insertId), role],
  );
  const tokenHash = randomBytes(32);
  const sessionTime = new Date(Date.now() - 60_000);
  const sessionExpiry = new Date(Date.now() + 24 * 60 * 60_000);
  const [session] = await connection.query<ResultSetHeader>(
    `INSERT INTO sessions
      (user_id, token_hash, client_type, authenticated_at, last_seen_at,
       expires_at, created_at)
     VALUES (?,?,'WEB',?,?,?,?)`,
    [
      String(user.insertId),
      tokenHash,
      sessionTime,
      sessionTime,
      sessionExpiry,
      sessionTime,
    ],
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
  owner: string,
  name: string,
) {
  const [row] = await connection.query<ResultSetHeader>(
    "INSERT INTO albums (family_id,owner_member_id,name,visibility) VALUES (?,?,?,'CUSTOM')",
    [familyId, owner, name],
  );
  return String(row.insertId);
}

async function putViewGrant(
  connection: PoolConnection,
  familyId: string,
  albumId: string,
  memberId: string,
  canView: boolean,
) {
  await connection.query(
    `INSERT INTO album_members (family_id,album_id,member_id,can_view)
     VALUES (?,?,?,?)`,
    [familyId, albumId, memberId, canView],
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

async function insertReadyDerived(
  connection: PoolConnection,
  familyId: string,
  mediaId: string,
) {
  const [job] = await connection.query<ResultSetHeader>(
    `INSERT INTO background_jobs
      (family_id,media_id,generation,recipe_id,job_type,state,available_at)
     VALUES (?,?,1,1,'IMAGE_DERIVATIVES','QUEUED',CURRENT_TIMESTAMP(3))`,
    [familyId, mediaId],
  );
  for (const kind of ["THUMBNAIL", "PREVIEW"] as const) {
    await connection.query(
      `INSERT INTO derived_assets
        (family_id,media_id,generation,recipe_id,kind,state,reserved_bytes,
         byte_size,sha256,width,height,output_mime,producer_job_id,
         producer_lease_epoch,published_at)
       VALUES (?,?,1,1,?,'READY',8,8,?,8,4,'image/webp',?,1,CURRENT_TIMESTAMP(3))`,
      [familyId, mediaId, kind, randomBytes(32), String(job.insertId)],
    );
  }
}
