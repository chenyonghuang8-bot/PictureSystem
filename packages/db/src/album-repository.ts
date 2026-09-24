import type {
  Pool,
  PoolConnection,
  ResultSetHeader,
  RowDataPacket,
} from "mysql2/promise";

import {
  evaluateAlbumPermissions,
  isPermissionSubset,
  type AlbumPermissionGrant,
  type AlbumVisibility,
  type FamilyRole,
} from "@family-album/permissions";

import {
  acquireCheckedConnection,
  readServerTime,
  runCheckedTransaction,
} from "./connection.js";
import type { Phase1CActor } from "./phase1c-repository.js";

const IDLE_TIMEOUT_MS = 7 * 24 * 60 * 60_000;
const RECENT_AUTH_MS = 15 * 60_000;

export type AlbumRecord = {
  id: string;
  familyId: string;
  ownerMemberId: string;
  name: string;
  description: string | null;
  visibility: AlbumVisibility;
  revision: string;
  createdAt: Date;
  updatedAt: Date;
  effectivePermissions: AlbumPermissionGrant;
};

export type AlbumMemberRecord = AlbumPermissionGrant & {
  memberId: string;
  displayName: string | null;
  active: boolean;
  isOwner: boolean;
};

export type AlbumMediaRecord = {
  mediaId: string;
  timelineKey: Date;
  timelineBasis: "CAPTURE_LOCAL" | "UPLOAD_UTC";
  displayWidth: number | null;
  displayHeight: number | null;
  orientation: number | null;
  capturedLocalAt: Date | null;
  cameraMake: string | null;
  cameraModel: string | null;
};

export class AlbumRepositoryError extends Error {
  constructor(
    readonly reason: "UNAUTHENTICATED" | "FORBIDDEN" | "NOT_FOUND" | "CONFLICT",
  ) {
    super(reason);
    this.name = "AlbumRepositoryError";
  }
}

type ActorMemberRow = RowDataPacket & {
  id: string;
  familyId: string;
  userId: string;
  role: FamilyRole;
  disabledAt: Date | null;
  leftAt: Date | null;
};
type UserRow = RowDataPacket & {
  id: string;
  displayName: string | null;
  disabledAt: Date | null;
};
type SessionRow = RowDataPacket & {
  tokenHash: Buffer;
  clientType: "WEB" | "ANDROID";
  authenticatedAt: Date;
  lastSeenAt: Date;
  expiresAt: Date;
  revokedAt: Date | null;
};
type AlbumRow = RowDataPacket & {
  id: string;
  familyId: string;
  ownerMemberId: string;
  name: string;
  description: string | null;
  visibility: AlbumVisibility;
  revision: string;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
};
type GrantRow = RowDataPacket & AlbumPermissionGrant & { id: string };
type LockedActor = {
  member: ActorMemberRow;
  user: UserRow | undefined;
  session: SessionRow | undefined;
};
type AclState = LockedActor & {
  album: AlbumRow | undefined;
  actorGrant: GrantRow | undefined;
  targetMember: ActorMemberRow | undefined;
  targetUser: UserRow | undefined;
  targetGrant: GrantRow | undefined;
};

export class MySqlAlbumRepository {
  constructor(private readonly pool: Pool) {}

  async createAlbum(input: {
    actor: Phase1CActor;
    familyId: string;
    name: string;
    description: string | null;
    visibility: AlbumVisibility;
  }): Promise<AlbumRecord & { actorMemberId: string }> {
    return runCheckedTransaction(this.pool, async (connection) => {
      await lockFamily(connection, input.familyId);
      const actor = await lockActor(connection, input.familyId, input.actor);
      const now = await readServerTime(connection);
      assertActor(actor, input.actor, now);
      assertRecentAuth(actor.session, now);

      await connection.query<ResultSetHeader>(
        `INSERT INTO albums
          (family_id, owner_member_id, name, description, visibility,
           revision, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 1, ?, ?)`,
        [
          input.familyId,
          actor.member.id,
          input.name,
          input.description,
          input.visibility,
          now,
          now,
        ],
      );
      const [ids] = await connection.query<RowDataPacket[]>(
        "SELECT CAST(LAST_INSERT_ID() AS CHAR) AS id",
      );
      const id = String(ids[0]?.id ?? "");
      if (!id) throw new Error("Album insert result is unavailable.");
      return {
        id,
        familyId: input.familyId,
        ownerMemberId: actor.member.id,
        name: input.name,
        description: input.description,
        visibility: input.visibility,
        revision: "1",
        createdAt: now,
        updatedAt: now,
        effectivePermissions: ownerPermissions(),
        actorMemberId: actor.member.id,
      };
    });
  }

  async listAlbums(input: {
    actor: Phase1CActor;
    familyId: string;
    afterId?: string;
    limit: number;
  }): Promise<AlbumRecord[]> {
    return runCheckedTransaction(this.pool, async (connection) => {
      await lockFamily(connection, input.familyId);
      const actor = await lockActor(connection, input.familyId, input.actor);

      // The family row is the coarse Phase 2 mutex. This SQL applies the view
      // predicate before LIMIT so hidden rows neither leak nor consume a page.
      const [located] = await connection.query<RowDataPacket[]>(
        `SELECT CAST(a.id AS CHAR) AS id,
                CAST(am.id AS CHAR) AS grantId
           FROM albums a
           LEFT JOIN album_members am
             ON am.family_id = a.family_id AND am.album_id = a.id
            AND am.member_id = ?
          WHERE a.family_id = ? AND a.deleted_at IS NULL
            AND a.id > ?
            AND (a.owner_member_id = ? OR a.visibility = 'FAMILY'
                 OR am.can_view = 1)
          ORDER BY a.id ASC LIMIT ?`,
        [
          actor.member.id,
          input.familyId,
          input.afterId ?? "0",
          actor.member.id,
          input.limit,
        ],
      );
      const albumIds = located.map((row) => String(row.id));
      const grantIds = located
        .filter((row) => row.grantId !== null)
        .map((row) => String(row.grantId));
      await lockIds(connection, "albums", albumIds);
      await lockIds(connection, "album_members", grantIds);

      const now = await readServerTime(connection);
      assertActor(actor, input.actor, now);
      if (albumIds.length === 0) return [];

      const [rows] = await connection.query<(AlbumRow & GrantRow)[]>(
        `SELECT CAST(a.id AS CHAR) AS id, CAST(a.family_id AS CHAR) AS familyId,
                CAST(a.owner_member_id AS CHAR) AS ownerMemberId,
                a.name, a.description, a.visibility,
                CAST(a.revision AS CHAR) AS revision,
                a.created_at AS createdAt, a.updated_at AS updatedAt,
                a.deleted_at AS deletedAt,
                COALESCE(am.can_view, 0) AS canView,
                COALESCE(am.can_upload, 0) AS canUpload,
                COALESCE(am.can_edit, 0) AS canEdit,
                COALESCE(am.can_delete, 0) AS canDelete,
                COALESCE(am.can_manage_members, 0) AS canManageMembers
           FROM albums a
           LEFT JOIN album_members am
             ON am.family_id = a.family_id AND am.album_id = a.id
            AND am.member_id = ?
          WHERE a.family_id = ? AND a.id IN (?)
          ORDER BY a.id ASC`,
        [actor.member.id, input.familyId, albumIds],
      );
      return rows
        .map((row) => toAlbumRecord(row, actor.member, row))
        .filter((album) => album.effectivePermissions.canView);
    });
  }

  async getAlbum(input: {
    actor: Phase1CActor;
    albumId: string;
  }): Promise<AlbumRecord> {
    const familyId = await this.locateAlbumFamily(input.albumId);
    if (!familyId) throw new AlbumRepositoryError("NOT_FOUND");
    return runCheckedTransaction(this.pool, async (connection) => {
      await lockFamily(connection, familyId);
      const actor = await lockActor(connection, familyId, input.actor);
      const album = await lockAlbum(connection, familyId, input.albumId);
      const grant = album
        ? await lockGrant(connection, familyId, album.id, actor.member.id)
        : undefined;
      const now = await readServerTime(connection);
      assertActor(actor, input.actor, now);
      return assertVisible(album, actor.member, grant);
    });
  }

  async listAlbumMedia(input: {
    actor: Phase1CActor;
    albumId: string;
    limit: number;
    cursor?: { timelineKey: Date; mediaId: string };
  }): Promise<AlbumMediaRecord[]> {
    return this.withVisibleAlbum(
      input.actor,
      input.albumId,
      (connection, album) =>
        readAlbumMedia(connection, album, input.limit, input.cursor),
    );
  }

  async getAlbumMedia(input: {
    actor: Phase1CActor;
    albumId: string;
    mediaId: string;
  }): Promise<AlbumMediaRecord> {
    const rows = await this.withVisibleAlbum(
      input.actor,
      input.albumId,
      (connection, album) =>
        readAlbumMedia(connection, album, 1, undefined, input.mediaId),
    );
    const row = rows[0];
    if (!row) throw new AlbumRepositoryError("NOT_FOUND");
    return row;
  }

  private async withVisibleAlbum<T>(
    actor: Phase1CActor,
    albumId: string,
    read: (connection: PoolConnection, album: AlbumRecord) => Promise<T>,
  ): Promise<T> {
    const familyId = await this.locateAlbumFamily(albumId);
    if (!familyId) throw new AlbumRepositoryError("NOT_FOUND");
    return runCheckedTransaction(this.pool, async (connection) => {
      await lockFamily(connection, familyId);
      const locked = await lockActor(connection, familyId, actor);
      const album = await lockAlbum(connection, familyId, albumId);
      const grant = album
        ? await lockGrant(connection, familyId, album.id, locked.member.id)
        : undefined;
      const now = await readServerTime(connection);
      assertActor(locked, actor, now);
      const visible = assertVisible(album, locked.member, grant);
      return read(connection, visible);
    });
  }

  async updateAlbum(input: {
    actor: Phase1CActor;
    albumId: string;
    expectedRevision: string;
    name?: string;
    description?: string | null;
    visibility?: AlbumVisibility;
  }): Promise<
    AlbumRecord & { actorMemberId: string; changedFields: string[] }
  > {
    const familyId = await this.locateAlbumFamily(input.albumId);
    if (!familyId) throw new AlbumRepositoryError("NOT_FOUND");
    return runCheckedTransaction(this.pool, async (connection) => {
      await lockFamily(connection, familyId);
      const actor = await lockActor(connection, familyId, input.actor);
      const album = await lockAlbum(connection, familyId, input.albumId);
      const grant = album
        ? await lockGrant(connection, familyId, album.id, actor.member.id)
        : undefined;
      const now = await readServerTime(connection);
      assertActor(actor, input.actor, now);
      const current = assertVisible(album, actor.member, grant);
      if (input.visibility !== undefined) {
        assertRecentAuth(actor.session, now);
      }
      if (!current.effectivePermissions.canEdit) {
        throw new AlbumRepositoryError("FORBIDDEN");
      }
      if (
        input.visibility !== undefined &&
        current.ownerMemberId !== actor.member.id
      ) {
        throw new AlbumRepositoryError("FORBIDDEN");
      }
      if (current.revision !== input.expectedRevision) {
        throw new AlbumRepositoryError("CONFLICT");
      }

      const changedFields: string[] = [];
      if (input.name !== undefined && input.name !== current.name)
        changedFields.push("name");
      if (
        input.description !== undefined &&
        input.description !== current.description
      )
        changedFields.push("description");
      if (
        input.visibility !== undefined &&
        input.visibility !== current.visibility
      )
        changedFields.push("visibility");
      if (changedFields.length === 0) {
        return { ...current, actorMemberId: actor.member.id, changedFields };
      }

      const assignments: string[] = [];
      const values: unknown[] = [];
      if (changedFields.includes("name")) {
        assignments.push("name = ?");
        values.push(input.name);
      }
      if (changedFields.includes("description")) {
        assignments.push("description = ?");
        values.push(input.description);
      }
      if (changedFields.includes("visibility")) {
        assignments.push("visibility = ?");
        values.push(input.visibility);
      }
      const [updated] = await connection.query<ResultSetHeader>(
        `UPDATE albums SET ${assignments.join(", ")},
                revision = revision + 1, updated_at = ?
          WHERE id = ? AND family_id = ? AND revision = ?
            AND deleted_at IS NULL`,
        [...values, now, input.albumId, familyId, input.expectedRevision],
      );
      if (updated.affectedRows !== 1) {
        throw new AlbumRepositoryError("CONFLICT");
      }
      const refreshed = await readAlbum(connection, familyId, input.albumId);
      if (!refreshed) throw new AlbumRepositoryError("CONFLICT");
      return {
        ...toAlbumRecord(refreshed, actor.member, grant),
        actorMemberId: actor.member.id,
        changedFields,
      };
    });
  }

  async softDeleteAlbum(input: {
    actor: Phase1CActor;
    albumId: string;
    expectedRevision: string;
  }): Promise<{ actorMemberId: string; familyId: string; revision: string }> {
    const familyId = await this.locateAlbumFamily(input.albumId);
    if (!familyId) throw new AlbumRepositoryError("NOT_FOUND");
    return runCheckedTransaction(this.pool, async (connection) => {
      await lockFamily(connection, familyId);
      const actor = await lockActor(connection, familyId, input.actor);
      const album = await lockAlbum(connection, familyId, input.albumId);
      const grant = album
        ? await lockGrant(connection, familyId, album.id, actor.member.id)
        : undefined;
      const now = await readServerTime(connection);
      assertActor(actor, input.actor, now);
      const current = assertVisible(album, actor.member, grant);
      assertRecentAuth(actor.session, now);
      if (current.ownerMemberId !== actor.member.id) {
        throw new AlbumRepositoryError("FORBIDDEN");
      }
      if (current.revision !== input.expectedRevision) {
        throw new AlbumRepositoryError("CONFLICT");
      }
      const [updated] = await connection.query<ResultSetHeader>(
        `UPDATE albums SET deleted_at = ?, updated_at = ?, revision = revision + 1
          WHERE id = ? AND family_id = ? AND revision = ?
            AND deleted_at IS NULL`,
        [now, now, input.albumId, familyId, input.expectedRevision],
      );
      if (updated.affectedRows !== 1) {
        throw new AlbumRepositoryError("CONFLICT");
      }
      return {
        actorMemberId: actor.member.id,
        familyId,
        revision: (BigInt(current.revision) + 1n).toString(),
      };
    });
  }

  async listAlbumMembers(input: {
    actor: Phase1CActor;
    albumId: string;
  }): Promise<AlbumMemberRecord[]> {
    const familyId = await this.locateAlbumFamily(input.albumId);
    if (!familyId) throw new AlbumRepositoryError("NOT_FOUND");
    return runCheckedTransaction(this.pool, async (connection) => {
      await lockFamily(connection, familyId);
      const [albumLocation] = await connection.query<RowDataPacket[]>(
        `SELECT CAST(owner_member_id AS CHAR) AS ownerMemberId
           FROM albums WHERE id = ? AND family_id = ? LIMIT 1`,
        [input.albumId, familyId],
      );
      const ownerMemberId = albumLocation[0]
        ? String(albumLocation[0].ownerMemberId)
        : null;
      const [grantLocations] = await connection.query<RowDataPacket[]>(
        `SELECT CAST(id AS CHAR) AS id, CAST(member_id AS CHAR) AS memberId
           FROM album_members WHERE family_id = ? AND album_id = ?
          ORDER BY id ASC`,
        [familyId, input.albumId],
      );
      const actorLocation = await locateMemberByUser(
        connection,
        familyId,
        input.actor.userId,
      );
      if (!actorLocation) throw new AlbumRepositoryError("NOT_FOUND");
      const relevantMemberIds = [
        actorLocation.id,
        ...(ownerMemberId ? [ownerMemberId] : []),
        ...grantLocations.map((row) => String(row.memberId)),
      ];
      const locations = await locateMembersByIds(
        connection,
        familyId,
        relevantMemberIds,
      );
      const users = await lockUsers(
        connection,
        locations.map((member) => member.userId),
      );
      const session = await lockActorSession(connection, input.actor);
      const members = await lockMembers(
        connection,
        familyId,
        locations.map((member) => member.id),
      );
      const album = await lockAlbum(connection, familyId, input.albumId);
      const grants = await lockGrantsByIds(
        connection,
        grantLocations.map((row) => String(row.id)),
      );
      const now = await readServerTime(connection);
      const actorMember = members.get(actorLocation.id);
      if (!actorMember) throw new AlbumRepositoryError("NOT_FOUND");
      const actorState: LockedActor = {
        member: actorMember,
        user: users.get(input.actor.userId),
        session,
      };
      assertActor(actorState, input.actor, now);
      const actorGrant = [...grants.values()].find(
        (grant) =>
          grantLocations.find((row) => String(row.id) === grant.id)
            ?.memberId === actorMember.id,
      );
      const visible = assertVisible(album, actorMember, actorGrant);
      if (!visible.effectivePermissions.canManageMembers) {
        throw new AlbumRepositoryError("FORBIDDEN");
      }

      const records = new Map<string, AlbumMemberRecord>();
      if (ownerMemberId) {
        const owner = members.get(ownerMemberId);
        const ownerUser = owner ? users.get(owner.userId) : undefined;
        if (owner && ownerUser) {
          records.set(owner.id, {
            memberId: owner.id,
            displayName: ownerUser.displayName,
            active: !ownerUser.disabledAt && !owner.disabledAt && !owner.leftAt,
            isOwner: true,
            ...ownerPermissions(),
          });
        }
      }
      for (const location of grantLocations) {
        const memberId = String(location.memberId);
        if (memberId === ownerMemberId) continue;
        const member = members.get(memberId);
        const user = member ? users.get(member.userId) : undefined;
        const grant = grants.get(String(location.id));
        if (!member || !user || !grant) continue;
        records.set(memberId, {
          memberId,
          displayName: user.displayName,
          active: !user.disabledAt && !member.disabledAt && !member.leftAt,
          isOwner: false,
          ...grantPermissions(grant),
        });
      }
      return [...records.values()].sort((left, right) =>
        compareIds(left.memberId, right.memberId),
      );
    });
  }

  async putAlbumMember(input: {
    actor: Phase1CActor;
    albumId: string;
    targetMemberId: string;
    expectedRevision: string;
    permissions: AlbumPermissionGrant;
  }): Promise<{
    actorMemberId: string;
    familyId: string;
    revision: string;
    action: "ADDED" | "CHANGED" | "NONE";
  }> {
    const familyId = await this.locateAlbumFamily(input.albumId);
    if (!familyId) throw new AlbumRepositoryError("NOT_FOUND");
    return runCheckedTransaction(this.pool, async (connection) => {
      await lockFamily(connection, familyId);
      const state = await lockAclState(connection, familyId, input.actor, {
        albumId: input.albumId,
        targetMemberId: input.targetMemberId,
      });
      const now = await readServerTime(connection);
      assertActor(state, input.actor, now);
      const current = assertVisible(
        state.album,
        state.member,
        state.actorGrant,
      );
      assertRecentAuth(state.session, now);
      assertCanMutateGrant(
        state,
        current.effectivePermissions,
        input.permissions,
      );
      if (current.revision !== input.expectedRevision) {
        throw new AlbumRepositoryError("CONFLICT");
      }
      const existing = state.targetGrant
        ? grantPermissions(state.targetGrant)
        : null;
      if (existing && samePermissions(existing, input.permissions)) {
        return {
          actorMemberId: state.member.id,
          familyId,
          revision: current.revision,
          action: "NONE",
        };
      }

      const nextRevision = await advanceAlbumRevision(
        connection,
        state.album!,
        input.expectedRevision,
        now,
      );
      if (state.targetGrant) {
        const [updated] = await connection.query<ResultSetHeader>(
          `UPDATE album_members
              SET can_view = ?, can_upload = ?, can_edit = ?, can_delete = ?,
                  can_manage_members = ?, updated_at = ?
            WHERE id = ? AND family_id = ? AND album_id = ? AND member_id = ?`,
          [
            input.permissions.canView,
            input.permissions.canUpload,
            input.permissions.canEdit,
            input.permissions.canDelete,
            input.permissions.canManageMembers,
            now,
            state.targetGrant.id,
            familyId,
            input.albumId,
            input.targetMemberId,
          ],
        );
        if (updated.affectedRows !== 1) {
          throw new AlbumRepositoryError("CONFLICT");
        }
      } else {
        await connection.query<ResultSetHeader>(
          `INSERT INTO album_members
            (family_id, album_id, member_id, can_view, can_upload, can_edit,
             can_delete, can_manage_members, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            familyId,
            input.albumId,
            input.targetMemberId,
            input.permissions.canView,
            input.permissions.canUpload,
            input.permissions.canEdit,
            input.permissions.canDelete,
            input.permissions.canManageMembers,
            now,
            now,
          ],
        );
      }
      return {
        actorMemberId: state.member.id,
        familyId,
        revision: nextRevision,
        action: state.targetGrant ? "CHANGED" : "ADDED",
      };
    });
  }

  async removeAlbumMember(input: {
    actor: Phase1CActor;
    albumId: string;
    targetMemberId: string;
    expectedRevision: string;
  }): Promise<{
    actorMemberId: string;
    familyId: string;
    revision: string;
    changed: boolean;
  }> {
    const familyId = await this.locateAlbumFamily(input.albumId);
    if (!familyId) throw new AlbumRepositoryError("NOT_FOUND");
    return runCheckedTransaction(this.pool, async (connection) => {
      await lockFamily(connection, familyId);
      const state = await lockAclState(connection, familyId, input.actor, {
        albumId: input.albumId,
        targetMemberId: input.targetMemberId,
      });
      const now = await readServerTime(connection);
      assertActor(state, input.actor, now);
      const current = assertVisible(
        state.album,
        state.member,
        state.actorGrant,
      );
      assertRecentAuth(state.session, now);
      assertCanMutateGrant(state, current.effectivePermissions);
      if (current.revision !== input.expectedRevision) {
        throw new AlbumRepositoryError("CONFLICT");
      }
      if (!state.targetGrant) {
        return {
          actorMemberId: state.member.id,
          familyId,
          revision: current.revision,
          changed: false,
        };
      }
      const nextRevision = await advanceAlbumRevision(
        connection,
        state.album!,
        input.expectedRevision,
        now,
      );
      const [removed] = await connection.query<ResultSetHeader>(
        `DELETE FROM album_members
          WHERE id = ? AND family_id = ? AND album_id = ? AND member_id = ?`,
        [state.targetGrant.id, familyId, input.albumId, input.targetMemberId],
      );
      if (removed.affectedRows !== 1) {
        throw new AlbumRepositoryError("CONFLICT");
      }
      return {
        actorMemberId: state.member.id,
        familyId,
        revision: nextRevision,
        changed: true,
      };
    });
  }

  private async locateAlbumFamily(albumId: string): Promise<string | null> {
    const connection = await acquireCheckedConnection(this.pool);
    try {
      const [rows] = await connection.query<RowDataPacket[]>(
        "SELECT CAST(family_id AS CHAR) AS familyId FROM albums WHERE id = ? LIMIT 1",
        [albumId],
      );
      return rows[0] ? String(rows[0].familyId) : null;
    } finally {
      connection.release();
    }
  }
}

async function lockFamily(connection: PoolConnection, familyId: string) {
  const [rows] = await connection.query<RowDataPacket[]>(
    "SELECT CAST(id AS CHAR) AS id FROM families WHERE id = ? FOR UPDATE",
    [familyId],
  );
  if (!rows[0]) throw new AlbumRepositoryError("NOT_FOUND");
}

async function lockActor(
  connection: PoolConnection,
  familyId: string,
  actor: Phase1CActor,
): Promise<LockedActor> {
  const [located] = await connection.query<RowDataPacket[]>(
    `SELECT CAST(id AS CHAR) AS id FROM family_members
      WHERE family_id = ? AND user_id = ? LIMIT 1`,
    [familyId, actor.userId],
  );
  const memberId = located[0] ? String(located[0].id) : null;
  if (!memberId) throw new AlbumRepositoryError("NOT_FOUND");

  const [users] = await connection.query<UserRow[]>(
    `SELECT CAST(id AS CHAR) AS id, display_name AS displayName,
            disabled_at AS disabledAt
       FROM users WHERE id = ? FOR UPDATE`,
    [actor.userId],
  );
  const [sessions] = await connection.query<SessionRow[]>(
    `SELECT token_hash AS tokenHash, client_type AS clientType,
            authenticated_at AS authenticatedAt, last_seen_at AS lastSeenAt,
            expires_at AS expiresAt, revoked_at AS revokedAt
       FROM sessions WHERE id = ? AND user_id = ? FOR UPDATE`,
    [actor.sessionId, actor.userId],
  );
  const [members] = await connection.query<ActorMemberRow[]>(
    `SELECT CAST(id AS CHAR) AS id, CAST(family_id AS CHAR) AS familyId,
            CAST(user_id AS CHAR) AS userId, role,
            disabled_at AS disabledAt, left_at AS leftAt
       FROM family_members WHERE id = ? AND family_id = ? FOR UPDATE`,
    [memberId, familyId],
  );
  const member = members[0];
  if (!member) throw new AlbumRepositoryError("NOT_FOUND");
  return { member, user: users[0], session: sessions[0] };
}

async function lockAclState(
  connection: PoolConnection,
  familyId: string,
  actor: Phase1CActor,
  input: { albumId: string; targetMemberId: string },
): Promise<AclState> {
  const actorLocation = await locateMemberByUser(
    connection,
    familyId,
    actor.userId,
  );
  if (!actorLocation) throw new AlbumRepositoryError("NOT_FOUND");
  const targetLocation = (
    await locateMembersByIds(connection, familyId, [input.targetMemberId])
  )[0];
  const locations = [
    actorLocation,
    ...(targetLocation ? [targetLocation] : []),
  ];
  const users = await lockUsers(
    connection,
    locations.map((member) => member.userId),
  );
  const session = await lockActorSession(connection, actor);
  const members = await lockMembers(
    connection,
    familyId,
    locations.map((member) => member.id),
  );
  const album = await lockAlbum(connection, familyId, input.albumId);
  const grants = await lockGrantsForMembers(
    connection,
    familyId,
    input.albumId,
    [actorLocation.id, input.targetMemberId],
  );
  const actorMember = members.get(actorLocation.id);
  if (!actorMember) throw new AlbumRepositoryError("NOT_FOUND");
  const targetMember = targetLocation
    ? members.get(targetLocation.id)
    : undefined;
  return {
    member: actorMember,
    user: users.get(actor.userId),
    session,
    album,
    actorGrant: grants.get(actorLocation.id),
    targetMember,
    targetUser: targetMember ? users.get(targetMember.userId) : undefined,
    targetGrant: grants.get(input.targetMemberId),
  };
}

async function locateMemberByUser(
  connection: PoolConnection,
  familyId: string,
  userId: string,
) {
  const [rows] = await connection.query<RowDataPacket[]>(
    `SELECT CAST(id AS CHAR) AS id, CAST(family_id AS CHAR) AS familyId,
            CAST(user_id AS CHAR) AS userId
       FROM family_members WHERE family_id = ? AND user_id = ? LIMIT 1`,
    [familyId, userId],
  );
  return rows[0]
    ? {
        id: String(rows[0].id),
        familyId: String(rows[0].familyId),
        userId: String(rows[0].userId),
      }
    : undefined;
}

async function locateMembersByIds(
  connection: PoolConnection,
  familyId: string,
  memberIds: readonly string[],
) {
  const unique = [...new Set(memberIds)];
  if (unique.length === 0) return [];
  const [rows] = await connection.query<RowDataPacket[]>(
    `SELECT CAST(id AS CHAR) AS id, CAST(family_id AS CHAR) AS familyId,
            CAST(user_id AS CHAR) AS userId
       FROM family_members WHERE family_id = ? AND id IN (?)`,
    [familyId, unique],
  );
  return rows.map((row) => ({
    id: String(row.id),
    familyId: String(row.familyId),
    userId: String(row.userId),
  }));
}

async function lockUsers(
  connection: PoolConnection,
  userIds: readonly string[],
) {
  const users = new Map<string, UserRow>();
  for (const userId of [...new Set(userIds)].sort(compareIds)) {
    const [rows] = await connection.query<UserRow[]>(
      `SELECT CAST(id AS CHAR) AS id, display_name AS displayName,
              disabled_at AS disabledAt
         FROM users WHERE id = ? FOR UPDATE`,
      [userId],
    );
    if (rows[0]) users.set(String(rows[0].id), rows[0]);
  }
  return users;
}

async function lockActorSession(
  connection: PoolConnection,
  actor: Phase1CActor,
) {
  const [rows] = await connection.query<SessionRow[]>(
    `SELECT token_hash AS tokenHash, client_type AS clientType,
            authenticated_at AS authenticatedAt, last_seen_at AS lastSeenAt,
            expires_at AS expiresAt, revoked_at AS revokedAt
       FROM sessions WHERE id = ? AND user_id = ? FOR UPDATE`,
    [actor.sessionId, actor.userId],
  );
  return rows[0];
}

async function lockMembers(
  connection: PoolConnection,
  familyId: string,
  memberIds: readonly string[],
) {
  const members = new Map<string, ActorMemberRow>();
  for (const memberId of [...new Set(memberIds)].sort(compareIds)) {
    const [rows] = await connection.query<ActorMemberRow[]>(
      `SELECT CAST(id AS CHAR) AS id, CAST(family_id AS CHAR) AS familyId,
              CAST(user_id AS CHAR) AS userId, role,
              disabled_at AS disabledAt, left_at AS leftAt
         FROM family_members WHERE id = ? AND family_id = ? FOR UPDATE`,
      [memberId, familyId],
    );
    if (rows[0]) members.set(String(rows[0].id), rows[0]);
  }
  return members;
}

async function lockGrantsForMembers(
  connection: PoolConnection,
  familyId: string,
  albumId: string,
  memberIds: readonly string[],
) {
  const [locations] = await connection.query<RowDataPacket[]>(
    `SELECT CAST(id AS CHAR) AS id, CAST(member_id AS CHAR) AS memberId
       FROM album_members
      WHERE family_id = ? AND album_id = ? AND member_id IN (?)`,
    [familyId, albumId, [...new Set(memberIds)]],
  );
  const grantsById = await lockGrantsByIds(
    connection,
    locations.map((row) => String(row.id)),
  );
  const byMember = new Map<string, GrantRow>();
  for (const location of locations) {
    const grant = grantsById.get(String(location.id));
    if (grant) byMember.set(String(location.memberId), grant);
  }
  return byMember;
}

async function lockGrantsByIds(
  connection: PoolConnection,
  grantIds: readonly string[],
) {
  const grants = new Map<string, GrantRow>();
  for (const grantId of [...new Set(grantIds)].sort(compareIds)) {
    const [rows] = await connection.query<GrantRow[]>(
      `SELECT CAST(id AS CHAR) AS id, can_view AS canView,
              can_upload AS canUpload, can_edit AS canEdit,
              can_delete AS canDelete, can_manage_members AS canManageMembers
         FROM album_members WHERE id = ? FOR UPDATE`,
      [grantId],
    );
    if (rows[0]) grants.set(String(rows[0].id), rows[0]);
  }
  return grants;
}

function assertActor(state: LockedActor, actor: Phase1CActor, now: Date) {
  const { member, user, session } = state;
  if (
    !user ||
    !session ||
    user.disabledAt ||
    member.userId !== actor.userId ||
    member.disabledAt ||
    member.leftAt ||
    session.clientType !== "WEB" ||
    session.revokedAt ||
    !Buffer.isBuffer(session.tokenHash) ||
    !session.tokenHash.equals(actor.tokenHash) ||
    now.getTime() >= session.expiresAt.getTime() ||
    now.getTime() >= session.lastSeenAt.getTime() + IDLE_TIMEOUT_MS
  ) {
    throw new AlbumRepositoryError("UNAUTHENTICATED");
  }
}

function assertRecentAuth(session: SessionRow | undefined, now: Date) {
  const age = session
    ? now.getTime() - session.authenticatedAt.getTime()
    : Number.POSITIVE_INFINITY;
  if (age < 0 || age >= RECENT_AUTH_MS) {
    throw new AlbumRepositoryError("FORBIDDEN");
  }
}

async function lockAlbum(
  connection: PoolConnection,
  familyId: string,
  albumId: string,
) {
  const [rows] = await connection.query<AlbumRow[]>(
    `${albumSelect()} WHERE id = ? AND family_id = ? FOR UPDATE`,
    [albumId, familyId],
  );
  return rows[0];
}

async function readAlbum(
  connection: PoolConnection,
  familyId: string,
  albumId: string,
) {
  const [rows] = await connection.query<AlbumRow[]>(
    `${albumSelect()} WHERE id = ? AND family_id = ?`,
    [albumId, familyId],
  );
  return rows[0];
}

function albumSelect() {
  return `SELECT CAST(id AS CHAR) AS id, CAST(family_id AS CHAR) AS familyId,
                 CAST(owner_member_id AS CHAR) AS ownerMemberId,
                 name, description, visibility, CAST(revision AS CHAR) AS revision,
                 created_at AS createdAt, updated_at AS updatedAt,
                 deleted_at AS deletedAt FROM albums`;
}

async function lockGrant(
  connection: PoolConnection,
  familyId: string,
  albumId: string,
  memberId: string,
) {
  const [ids] = await connection.query<RowDataPacket[]>(
    `SELECT CAST(id AS CHAR) AS id FROM album_members
      WHERE family_id = ? AND album_id = ? AND member_id = ? LIMIT 1`,
    [familyId, albumId, memberId],
  );
  if (!ids[0]) return undefined;
  const [rows] = await connection.query<GrantRow[]>(
    `SELECT CAST(id AS CHAR) AS id, can_view AS canView,
            can_upload AS canUpload, can_edit AS canEdit,
            can_delete AS canDelete, can_manage_members AS canManageMembers
       FROM album_members WHERE id = ? FOR UPDATE`,
    [String(ids[0].id)],
  );
  return rows[0];
}

async function lockIds(
  connection: PoolConnection,
  table: "albums" | "album_members",
  ids: readonly string[],
) {
  const sorted = [...new Set(ids)].sort(compareIds);
  for (const id of sorted) {
    await connection.query(`SELECT id FROM ${table} WHERE id = ? FOR UPDATE`, [
      id,
    ]);
  }
}

type AlbumMediaRow = RowDataPacket & {
  mediaId: string;
  timelineKey: Date;
  timelineBasis: AlbumMediaRecord["timelineBasis"];
  displayWidth: number | null;
  displayHeight: number | null;
  orientation: number | null;
  capturedLocalAt: Date | null;
  cameraMake: string | null;
  cameraModel: string | null;
};

async function readAlbumMedia(
  connection: PoolConnection,
  album: AlbumRecord,
  limit: number,
  cursor?: { timelineKey: Date; mediaId: string },
  mediaId?: string,
): Promise<AlbumMediaRecord[]> {
  const [rows] = await connection.query<AlbumMediaRow[]>(
    `SELECT CAST(m.id AS CHAR) AS mediaId,
            m.timeline_key AS timelineKey,
            m.timeline_basis AS timelineBasis,
            m.display_width AS displayWidth,
            m.display_height AS displayHeight,
            m.orientation AS orientation,
            m.captured_local_at AS capturedLocalAt,
            m.camera_make AS cameraMake,
            m.camera_model AS cameraModel
       FROM album_media am
       JOIN media_items m
         ON m.family_id = am.family_id AND m.id = am.media_id
      WHERE am.family_id = ? AND am.album_id = ?
        AND (? IS NULL OR am.media_id = ?)
        AND (
          ? = 0
          OR m.timeline_key < ?
          OR (m.timeline_key = ? AND m.id < ?)
        )
      ORDER BY m.timeline_key DESC, m.id DESC
      LIMIT ?`,
    [
      album.familyId,
      album.id,
      mediaId ?? null,
      mediaId ?? null,
      cursor ? 1 : 0,
      cursor?.timelineKey ?? new Date(0),
      cursor?.timelineKey ?? new Date(0),
      cursor?.mediaId ?? "0",
      limit,
    ],
  );
  return rows.map((row) => ({
    mediaId: String(row.mediaId),
    timelineKey: row.timelineKey,
    timelineBasis: row.timelineBasis,
    displayWidth: nullableInteger(row.displayWidth),
    displayHeight: nullableInteger(row.displayHeight),
    orientation: nullableInteger(row.orientation),
    capturedLocalAt: row.capturedLocalAt,
    cameraMake: row.cameraMake,
    cameraModel: row.cameraModel,
  }));
}

function nullableInteger(value: number | null) {
  return value === null || value === undefined ? null : Number(value);
}

function assertVisible(
  album: AlbumRow | undefined,
  actor: ActorMemberRow,
  grant?: GrantRow,
): AlbumRecord {
  if (!album) throw new AlbumRepositoryError("NOT_FOUND");
  const result = toAlbumRecord(album, actor, grant);
  if (!result.effectivePermissions.canView) {
    throw new AlbumRepositoryError("NOT_FOUND");
  }
  return result;
}

function toAlbumRecord(
  row: AlbumRow,
  actor: ActorMemberRow,
  grant?: Partial<Record<keyof AlbumPermissionGrant, unknown>>,
): AlbumRecord {
  const explicitGrant = grant ? grantPermissions(grant) : null;
  return {
    id: String(row.id),
    familyId: String(row.familyId),
    ownerMemberId: String(row.ownerMemberId),
    name: row.name,
    description: row.description,
    visibility: row.visibility,
    revision: String(row.revision),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    effectivePermissions: evaluateAlbumPermissions({
      membershipExists: true,
      memberActive: !actor.disabledAt && !actor.leftAt,
      sameFamily: actor.familyId === String(row.familyId),
      albumDeleted: row.deletedAt !== null,
      isOwner: actor.id === String(row.ownerMemberId),
      visibility: row.visibility,
      explicitGrant,
      familyRole: actor.role,
    }),
  };
}

function ownerPermissions(): AlbumPermissionGrant {
  return {
    canView: true,
    canUpload: true,
    canEdit: true,
    canDelete: true,
    canManageMembers: true,
  };
}

function grantPermissions(
  grant: Partial<Record<keyof AlbumPermissionGrant, unknown>>,
): AlbumPermissionGrant {
  return {
    canView: isGranted(grant.canView),
    canUpload: isGranted(grant.canUpload),
    canEdit: isGranted(grant.canEdit),
    canDelete: isGranted(grant.canDelete),
    canManageMembers: isGranted(grant.canManageMembers),
  };
}

function isGranted(value: unknown) {
  return value === true || value === 1 || value === 1n || value === "1";
}

function assertCanMutateGrant(
  state: AclState,
  actorPermissions: AlbumPermissionGrant,
  requestedPermissions?: AlbumPermissionGrant,
) {
  if (!actorPermissions.canManageMembers) {
    throw new AlbumRepositoryError("FORBIDDEN");
  }
  const target = state.targetMember;
  if (!target) throw new AlbumRepositoryError("NOT_FOUND");
  if (
    target.id === state.member.id ||
    target.id === state.album?.ownerMemberId
  ) {
    throw new AlbumRepositoryError("FORBIDDEN");
  }
  const actorIsOwner = state.member.id === state.album?.ownerMemberId;
  const targetExisting = state.targetGrant
    ? grantPermissions(state.targetGrant)
    : null;

  if (requestedPermissions) {
    if (!Object.values(requestedPermissions).some(Boolean)) {
      throw new AlbumRepositoryError("CONFLICT");
    }
    if (
      !state.targetUser ||
      state.targetUser.disabledAt ||
      target.disabledAt ||
      target.leftAt
    ) {
      throw new AlbumRepositoryError("FORBIDDEN");
    }
    if (
      (requestedPermissions.canUpload ||
        requestedPermissions.canEdit ||
        requestedPermissions.canDelete ||
        requestedPermissions.canManageMembers) &&
      !requestedPermissions.canView
    ) {
      throw new AlbumRepositoryError("CONFLICT");
    }
  }

  if (actorIsOwner) return;
  if (
    targetExisting?.canManageMembers ||
    requestedPermissions?.canManageMembers ||
    (targetExisting && !isPermissionSubset(actorPermissions, targetExisting)) ||
    (requestedPermissions &&
      !isPermissionSubset(actorPermissions, requestedPermissions))
  ) {
    throw new AlbumRepositoryError("FORBIDDEN");
  }
}

async function advanceAlbumRevision(
  connection: PoolConnection,
  album: AlbumRow,
  expectedRevision: string,
  now: Date,
) {
  const [updated] = await connection.query<ResultSetHeader>(
    `UPDATE albums SET revision = revision + 1, updated_at = ?
      WHERE id = ? AND family_id = ? AND revision = ? AND deleted_at IS NULL`,
    [now, album.id, album.familyId, expectedRevision],
  );
  if (updated.affectedRows !== 1) {
    throw new AlbumRepositoryError("CONFLICT");
  }
  return (BigInt(expectedRevision) + 1n).toString();
}

function samePermissions(
  left: AlbumPermissionGrant,
  right: AlbumPermissionGrant,
) {
  return (
    left.canView === right.canView &&
    left.canUpload === right.canUpload &&
    left.canEdit === right.canEdit &&
    left.canDelete === right.canDelete &&
    left.canManageMembers === right.canManageMembers
  );
}

function compareIds(left: string, right: string) {
  return BigInt(left) < BigInt(right)
    ? -1
    : BigInt(left) > BigInt(right)
      ? 1
      : 0;
}
