import type {
  Pool,
  PoolConnection,
  ResultSetHeader,
  RowDataPacket,
} from "mysql2/promise";

import type {
  FamilyRole,
  InvitationRole,
  MemberMutation,
} from "@family-album/permissions";
import {
  canIssueInvitation,
  canListInvitations,
  canManageMember,
  canRevokeInvitation,
} from "@family-album/permissions";

import {
  acquireCheckedConnection,
  readServerTime,
  runCheckedTransaction,
} from "./connection.js";

const IDLE_TIMEOUT_MS = 7 * 24 * 60 * 60_000;
const RECENT_AUTH_MS = 15 * 60_000;

export type Phase1CActor = {
  userId: string;
  sessionId: string;
  tokenHash: Buffer;
};

export type InvitationRecord = {
  id: string;
  role: InvitationRole;
  createdAt: Date;
  expiresAt: Date;
  usedAt: Date | null;
  revokedAt: Date | null;
  creatorMemberId: string;
  creatorValid: boolean;
  serverNow: Date;
};

export type MemberRecord = {
  id: string;
  userId: string;
  username: string;
  displayName: string | null;
  role: FamilyRole;
  disabledAt: Date | null;
};

export class Phase1CRepositoryError extends Error {
  constructor(
    readonly reason:
      | "INVALID_INVITATION"
      | "UNAUTHENTICATED"
      | "FORBIDDEN"
      | "NOT_FOUND"
      | "CONFLICT",
  ) {
    super(reason);
    this.name = "Phase1CRepositoryError";
  }
}

type FamilyRow = RowDataPacket & { id: string; name: string };
type UserLockRow = RowDataPacket & {
  id: string;
  disabledAt: Date | null;
};
type MemberLockRow = RowDataPacket & {
  id: string;
  userId: string;
  role: FamilyRole;
  disabledAt: Date | null;
  leftAt: Date | null;
};
type SessionLockRow = RowDataPacket & {
  tokenHash: Buffer;
  clientType: "WEB" | "ANDROID";
  authenticatedAt: Date;
  lastSeenAt: Date;
  expiresAt: Date;
  revokedAt: Date | null;
};
type InvitationLockRow = RowDataPacket & {
  id: string;
  familyId: string;
  createdByMemberId: string;
  role: InvitationRole;
  tokenHash: Buffer;
  expiresAt: Date;
  usedAt: Date | null;
  revokedAt: Date | null;
};

type LockedFamilyState = {
  family: FamilyRow;
  users: Map<string, UserLockRow>;
  members: Map<string, MemberLockRow>;
  actorMember?: MemberLockRow;
  actorSession?: SessionLockRow;
};

export class MySqlPhase1CRepository {
  constructor(private readonly pool: Pool) {}

  async createInvitation(input: {
    actor: Phase1CActor;
    familyId: string;
    role: InvitationRole;
    expiresInHours: number;
    tokenHash: Buffer;
  }): Promise<{ id: string; expiresAt: Date; actorMemberId: string }> {
    return runCheckedTransaction(this.pool, async (connection) => {
      const state = await lockFamilyState(
        connection,
        input.familyId,
        input.actor,
      );
      const now = await readServerTime(connection);
      const actor = assertActor(state, input.actor, now, true);
      assertActiveSuperAdmin(state);
      if (!canIssueInvitation(actor.role, input.role)) {
        throw new Phase1CRepositoryError("FORBIDDEN");
      }
      const expiresAt = new Date(
        now.getTime() + input.expiresInHours * 60 * 60_000,
      );
      const [created] = await connection.query<ResultSetHeader>(
        `INSERT INTO invitations
          (family_id, created_by_member_id, role, token_hash, expires_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [input.familyId, actor.id, input.role, input.tokenHash, expiresAt, now],
      );
      return {
        id: String(created.insertId),
        expiresAt,
        actorMemberId: actor.id,
      };
    });
  }

  async listInvitations(
    actor: Phase1CActor,
    familyId: string,
  ): Promise<InvitationRecord[]> {
    const connection = await acquireCheckedConnection(this.pool);
    try {
      const [rows] = await connection.query<
        (RowDataPacket & InvitationRecord)[]
      >(
        `SELECT CAST(i.id AS CHAR) AS id, i.role,
                i.created_at AS createdAt, i.expires_at AS expiresAt,
                i.used_at AS usedAt, i.revoked_at AS revokedAt,
                CAST(i.created_by_member_id AS CHAR) AS creatorMemberId,
                (cm.disabled_at IS NULL AND cm.left_at IS NULL
                 AND cu.disabled_at IS NULL
                 AND (cm.role = 'SUPER_ADMIN' OR
                      (cm.role = 'ADMIN' AND i.role = 'MEMBER'))) AS creatorValid,
                CURRENT_TIMESTAMP(3) AS serverNow
           FROM invitations i
           JOIN family_members am ON am.family_id = i.family_id AND am.user_id = ?
           JOIN users au ON au.id = am.user_id
           JOIN sessions s ON s.id = ? AND s.user_id = am.user_id
           JOIN family_members cm ON cm.family_id = i.family_id
                                  AND cm.id = i.created_by_member_id
           JOIN users cu ON cu.id = cm.user_id
          WHERE i.family_id = ?
            AND am.disabled_at IS NULL AND am.left_at IS NULL
            AND au.disabled_at IS NULL AND am.role IN ('ADMIN','SUPER_ADMIN')
            AND s.client_type = 'WEB' AND s.token_hash = ?
            AND s.revoked_at IS NULL AND s.expires_at > CURRENT_TIMESTAMP(3)
            AND DATE_ADD(s.last_seen_at, INTERVAL 7 DAY) > CURRENT_TIMESTAMP(3)
            AND EXISTS (
              SELECT 1 FROM family_members sm JOIN users su ON su.id = sm.user_id
               WHERE sm.family_id = i.family_id AND sm.role = 'SUPER_ADMIN'
                 AND sm.disabled_at IS NULL AND sm.left_at IS NULL
                 AND su.disabled_at IS NULL
            )
          ORDER BY i.created_at DESC, i.id DESC LIMIT 100`,
        [actor.userId, actor.sessionId, familyId, actor.tokenHash],
      );
      if (rows.length === 0) {
        await assertCanListFamily(connection, actor, familyId);
      }
      return rows.map((row) => ({
        ...row,
        id: String(row.id),
        creatorMemberId: String(row.creatorMemberId),
        creatorValid: Boolean(row.creatorValid),
      }));
    } finally {
      connection.release();
    }
  }

  async revokeInvitation(input: {
    actor: Phase1CActor;
    familyId: string;
    invitationId: string;
  }): Promise<{ actorMemberId: string }> {
    return runCheckedTransaction(this.pool, async (connection) => {
      const state = await lockFamilyState(
        connection,
        input.familyId,
        input.actor,
      );
      const invitation = await lockInvitation(
        connection,
        input.familyId,
        input.invitationId,
      );
      const now = await readServerTime(connection);
      const actor = assertActor(state, input.actor, now, true);
      assertActiveSuperAdmin(state);
      if (!invitation) throw new Phase1CRepositoryError("NOT_FOUND");
      if (!canRevokeInvitation(actor.role, invitation.role)) {
        throw new Phase1CRepositoryError("FORBIDDEN");
      }
      if (invitation.usedAt) throw new Phase1CRepositoryError("CONFLICT");
      if (invitation.revokedAt) return { actorMemberId: actor.id };
      const [updated] = await connection.query<ResultSetHeader>(
        `UPDATE invitations
            SET revoked_at = ?, revoked_by_member_id = ?
          WHERE id = ? AND family_id = ?
            AND used_at IS NULL AND revoked_at IS NULL`,
        [now, actor.id, input.invitationId, input.familyId],
      );
      if (updated.affectedRows !== 1) {
        throw new Phase1CRepositoryError("CONFLICT");
      }
      return { actorMemberId: actor.id };
    });
  }

  async findInvitationByHash(tokenHash: Buffer): Promise<{
    id: string;
    familyId: string;
    creatorMemberId: string;
    creatorUserId: string;
  } | null> {
    const connection = await acquireCheckedConnection(this.pool);
    try {
      const [rows] = await connection.query<RowDataPacket[]>(
        `SELECT CAST(i.id AS CHAR) AS id, CAST(i.family_id AS CHAR) AS familyId,
                CAST(i.created_by_member_id AS CHAR) AS creatorMemberId,
                CAST(cm.user_id AS CHAR) AS creatorUserId
           FROM invitations i
           JOIN family_members cm ON cm.family_id = i.family_id
                                  AND cm.id = i.created_by_member_id
          WHERE i.token_hash = ? LIMIT 1`,
        [tokenHash],
      );
      const row = rows[0];
      return row
        ? {
            id: String(row.id),
            familyId: String(row.familyId),
            creatorMemberId: String(row.creatorMemberId),
            creatorUserId: String(row.creatorUserId),
          }
        : null;
    } finally {
      connection.release();
    }
  }

  async previewInvitation(tokenHash: Buffer): Promise<{
    familyName: string;
    role: InvitationRole;
    expiresAt: Date;
  }> {
    const connection = await acquireCheckedConnection(this.pool);
    try {
      const [rows] = await connection.query<RowDataPacket[]>(
        `SELECT f.name AS familyName, i.role, i.expires_at AS expiresAt
           FROM invitations i
           JOIN families f ON f.id = i.family_id
           JOIN family_members cm ON cm.family_id = i.family_id
                                  AND cm.id = i.created_by_member_id
           JOIN users cu ON cu.id = cm.user_id
          WHERE i.token_hash = ? AND i.used_at IS NULL AND i.revoked_at IS NULL
            AND i.expires_at > CURRENT_TIMESTAMP(3)
            AND cm.disabled_at IS NULL AND cm.left_at IS NULL
            AND cu.disabled_at IS NULL
            AND (cm.role = 'SUPER_ADMIN' OR
                 (cm.role = 'ADMIN' AND i.role = 'MEMBER'))
            AND EXISTS (
              SELECT 1 FROM family_members sm JOIN users su ON su.id = sm.user_id
               WHERE sm.family_id = i.family_id AND sm.role = 'SUPER_ADMIN'
                 AND sm.disabled_at IS NULL AND sm.left_at IS NULL
                 AND su.disabled_at IS NULL
            )
          LIMIT 1`,
        [tokenHash],
      );
      const row = rows[0];
      if (!row) throw new Phase1CRepositoryError("INVALID_INVITATION");
      return {
        familyName: String(row.familyName),
        role: row.role as InvitationRole,
        expiresAt: row.expiresAt as Date,
      };
    } finally {
      connection.release();
    }
  }

  async consumeInvitation(input: {
    locator: {
      id: string;
      familyId: string;
      creatorMemberId: string;
      creatorUserId: string;
    };
    tokenHash: Buffer;
    username: string;
    usernameNormalized: Buffer;
    passwordHash: string;
    displayName: string | null;
  }): Promise<{ familyId: string; userId: string; memberId: string }> {
    return runCheckedTransaction(this.pool, async (connection) => {
      const state = await lockFamilyState(connection, input.locator.familyId);
      const invitation = await lockInvitation(
        connection,
        input.locator.familyId,
        input.locator.id,
      );
      const now = await readServerTime(connection);
      assertActiveSuperAdmin(state);
      const creator = state.members.get(input.locator.creatorMemberId);
      const creatorUser = state.users.get(input.locator.creatorUserId);
      if (
        !invitation ||
        !creator ||
        !creatorUser ||
        creator.userId !== input.locator.creatorUserId ||
        invitation.createdByMemberId !== creator.id ||
        !invitation.tokenHash.equals(input.tokenHash) ||
        creator.disabledAt ||
        creator.leftAt ||
        creatorUser.disabledAt ||
        !canIssueInvitation(creator.role, invitation.role) ||
        invitation.usedAt ||
        invitation.revokedAt ||
        now.getTime() >= invitation.expiresAt.getTime()
      ) {
        throw new Phase1CRepositoryError("INVALID_INVITATION");
      }

      let user: ResultSetHeader;
      try {
        [user] = await connection.query<ResultSetHeader>(
          `INSERT INTO users
            (username, username_normalized, password_hash, display_name,
             password_changed_at, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
          [
            input.username,
            input.usernameNormalized,
            input.passwordHash,
            input.displayName,
            now,
            now,
            now,
          ],
        );
      } catch (error) {
        if (isUsernameDuplicate(error)) {
          throw new Phase1CRepositoryError("CONFLICT");
        }
        throw error;
      }
      const userId = String(user.insertId);
      const [member] = await connection.query<ResultSetHeader>(
        `INSERT INTO family_members
          (family_id, user_id, role, joined_at, updated_at)
         VALUES (?, ?, ?, ?, ?)`,
        [input.locator.familyId, userId, invitation.role, now, now],
      );
      const memberId = String(member.insertId);
      const [used] = await connection.query<ResultSetHeader>(
        `UPDATE invitations
            SET used_at = ?, used_by_member_id = ?
          WHERE id = ? AND family_id = ? AND token_hash = ?
            AND used_at IS NULL AND revoked_at IS NULL AND expires_at > ?`,
        [
          now,
          memberId,
          invitation.id,
          input.locator.familyId,
          input.tokenHash,
          now,
        ],
      );
      if (used.affectedRows !== 1) {
        throw new Phase1CRepositoryError("INVALID_INVITATION");
      }
      return { familyId: input.locator.familyId, userId, memberId };
    });
  }

  async listMembers(
    actor: Phase1CActor,
    familyId: string,
  ): Promise<MemberRecord[]> {
    const connection = await acquireCheckedConnection(this.pool);
    try {
      const [rows] = await connection.query<(RowDataPacket & MemberRecord)[]>(
        `SELECT CAST(m.id AS CHAR) AS id, CAST(m.user_id AS CHAR) AS userId,
                u.username, u.display_name AS displayName, m.role,
                m.disabled_at AS disabledAt
           FROM family_members m
           JOIN users u ON u.id = m.user_id
           JOIN family_members am ON am.family_id = m.family_id AND am.user_id = ?
           JOIN users au ON au.id = am.user_id
           JOIN sessions s ON s.id = ? AND s.user_id = am.user_id
          WHERE m.family_id = ? AND m.left_at IS NULL
            AND am.disabled_at IS NULL AND am.left_at IS NULL
            AND au.disabled_at IS NULL
            AND s.client_type = 'WEB' AND s.token_hash = ?
            AND s.revoked_at IS NULL AND s.expires_at > CURRENT_TIMESTAMP(3)
            AND DATE_ADD(s.last_seen_at, INTERVAL 7 DAY) > CURRENT_TIMESTAMP(3)
          ORDER BY m.id ASC LIMIT 100`,
        [actor.userId, actor.sessionId, familyId, actor.tokenHash],
      );
      if (rows.length === 0) {
        throw new Phase1CRepositoryError("NOT_FOUND");
      }
      return rows.map((row) => ({
        ...row,
        id: String(row.id),
        userId: String(row.userId),
      }));
    } finally {
      connection.release();
    }
  }

  async updateMember(input: {
    actor: Phase1CActor;
    familyId: string;
    targetMemberId: string;
    mutation: MemberMutation;
  }): Promise<{ actorMemberId: string; member: MemberRecord }> {
    return runCheckedTransaction(this.pool, async (connection) => {
      const state = await lockFamilyState(
        connection,
        input.familyId,
        input.actor,
      );
      const target = state.members.get(input.targetMemberId);
      const invitationIds = target
        ? await listPendingInvitationIds(connection, input.familyId, target.id)
        : [];
      for (const invitationId of invitationIds) {
        await lockInvitation(connection, input.familyId, invitationId);
      }
      const now = await readServerTime(connection);
      const actor = assertActor(state, input.actor, now, true);
      assertActiveSuperAdmin(state);
      if (!target) throw new Phase1CRepositoryError("NOT_FOUND");
      if (
        !canManageMember({
          actorRole: actor.role,
          actorMemberId: actor.id,
          targetRole: target.role,
          targetMemberId: target.id,
          mutation: input.mutation,
        })
      ) {
        throw new Phase1CRepositoryError("FORBIDDEN");
      }
      if (target.leftAt) throw new Phase1CRepositoryError("CONFLICT");

      if (input.mutation.kind === "ROLE") {
        await connection.query<ResultSetHeader>(
          `UPDATE family_members SET role = ?, updated_at = ?
            WHERE id = ? AND family_id = ?`,
          [input.mutation.role, now, input.targetMemberId, input.familyId],
        );
      } else {
        await connection.query<ResultSetHeader>(
          `UPDATE family_members SET disabled_at = ?, updated_at = ?
            WHERE id = ? AND family_id = ?`,
          [
            input.mutation.disabled ? now : null,
            now,
            input.targetMemberId,
            input.familyId,
          ],
        );
      }

      if (
        input.mutation.kind === "ROLE" ||
        (input.mutation.kind === "DISABLED" && input.mutation.disabled)
      ) {
        for (const invitationId of invitationIds) {
          await connection.query<ResultSetHeader>(
            `UPDATE invitations SET revoked_at = ?, revoked_by_member_id = NULL
              WHERE id = ? AND family_id = ?
                AND used_at IS NULL AND revoked_at IS NULL`,
            [now, invitationId, input.familyId],
          );
        }
      }

      const [rows] = await connection.query<RowDataPacket[]>(
        `SELECT CAST(m.id AS CHAR) AS id, CAST(m.user_id AS CHAR) AS userId,
                u.username, u.display_name AS displayName, m.role,
                m.disabled_at AS disabledAt
           FROM family_members m JOIN users u ON u.id = m.user_id
          WHERE m.id = ? AND m.family_id = ?`,
        [input.targetMemberId, input.familyId],
      );
      const row = rows[0]!;
      return {
        actorMemberId: actor.id,
        member: {
          id: String(row.id),
          userId: String(row.userId),
          username: String(row.username),
          displayName:
            row.displayName === null ? null : String(row.displayName),
          role: row.role as FamilyRole,
          disabledAt: row.disabledAt as Date | null,
        },
      };
    });
  }
}

async function lockFamilyState(
  connection: PoolConnection,
  familyId: string,
  actor?: Phase1CActor,
): Promise<LockedFamilyState> {
  const [families] = await connection.query<FamilyRow[]>(
    "SELECT CAST(id AS CHAR) AS id, name FROM families WHERE id = ? FOR UPDATE",
    [familyId],
  );
  const family = families[0];
  if (!family) throw new Phase1CRepositoryError("NOT_FOUND");

  const [located] = await connection.query<RowDataPacket[]>(
    `SELECT CAST(id AS CHAR) AS id, CAST(user_id AS CHAR) AS userId
       FROM family_members WHERE family_id = ? ORDER BY id ASC`,
    [familyId],
  );
  const memberIds = located.map((row) => String(row.id));
  const userIds = [
    ...new Set([
      ...located.map((row) => String(row.userId)),
      ...(actor ? [actor.userId] : []),
    ]),
  ].sort(compareIds);

  const users = new Map<string, UserLockRow>();
  for (const userId of userIds) {
    const [rows] = await connection.query<UserLockRow[]>(
      `SELECT CAST(id AS CHAR) AS id, disabled_at AS disabledAt
         FROM users WHERE id = ? FOR UPDATE`,
      [userId],
    );
    if (rows[0]) users.set(String(rows[0].id), rows[0]);
  }

  let actorSession: SessionLockRow | undefined;
  if (actor) {
    const [rows] = await connection.query<SessionLockRow[]>(
      `SELECT token_hash AS tokenHash, client_type AS clientType,
              authenticated_at AS authenticatedAt, last_seen_at AS lastSeenAt,
              expires_at AS expiresAt, revoked_at AS revokedAt
         FROM sessions WHERE id = ? AND user_id = ? FOR UPDATE`,
      [actor.sessionId, actor.userId],
    );
    actorSession = rows[0];
  }

  const members = new Map<string, MemberLockRow>();
  for (const memberId of memberIds.sort(compareIds)) {
    const [rows] = await connection.query<MemberLockRow[]>(
      `SELECT CAST(id AS CHAR) AS id, CAST(user_id AS CHAR) AS userId,
              role, disabled_at AS disabledAt, left_at AS leftAt
         FROM family_members WHERE id = ? AND family_id = ? FOR UPDATE`,
      [memberId, familyId],
    );
    if (rows[0]) members.set(String(rows[0].id), rows[0]);
  }
  const actorMember = actor
    ? [...members.values()].find((member) => member.userId === actor.userId)
    : undefined;
  return {
    family,
    users,
    members,
    ...(actorMember ? { actorMember } : {}),
    ...(actorSession ? { actorSession } : {}),
  };
}

function assertActor(
  state: LockedFamilyState,
  actor: Phase1CActor,
  now: Date,
  requireRecent: boolean,
) {
  const member = state.actorMember;
  const user = state.users.get(actor.userId);
  const session = state.actorSession;
  const age = session
    ? now.getTime() - session.authenticatedAt.getTime()
    : Number.POSITIVE_INFINITY;
  if (!member) {
    throw new Phase1CRepositoryError("NOT_FOUND");
  }
  if (
    !user ||
    !session ||
    user.disabledAt ||
    member.disabledAt ||
    member.leftAt ||
    session.clientType !== "WEB" ||
    session.revokedAt ||
    !Buffer.isBuffer(session.tokenHash) ||
    !session.tokenHash.equals(actor.tokenHash) ||
    now.getTime() >= session.expiresAt.getTime() ||
    now.getTime() >= session.lastSeenAt.getTime() + IDLE_TIMEOUT_MS
  ) {
    throw new Phase1CRepositoryError("UNAUTHENTICATED");
  }
  if (requireRecent && (age < 0 || age >= RECENT_AUTH_MS)) {
    throw new Phase1CRepositoryError("FORBIDDEN");
  }
  return member;
}

function assertActiveSuperAdmin(state: LockedFamilyState) {
  const active = [...state.members.values()].some((member) => {
    const user = state.users.get(member.userId);
    return (
      member.role === "SUPER_ADMIN" &&
      !member.disabledAt &&
      !member.leftAt &&
      user !== undefined &&
      !user.disabledAt
    );
  });
  if (!active) throw new Phase1CRepositoryError("FORBIDDEN");
}

async function lockInvitation(
  connection: PoolConnection,
  familyId: string,
  invitationId: string,
): Promise<InvitationLockRow | undefined> {
  const [rows] = await connection.query<InvitationLockRow[]>(
    `SELECT CAST(id AS CHAR) AS id, CAST(family_id AS CHAR) AS familyId,
            CAST(created_by_member_id AS CHAR) AS createdByMemberId,
            role, token_hash AS tokenHash, expires_at AS expiresAt,
            used_at AS usedAt, revoked_at AS revokedAt
       FROM invitations WHERE id = ? AND family_id = ? FOR UPDATE`,
    [invitationId, familyId],
  );
  return rows[0];
}

async function listPendingInvitationIds(
  connection: PoolConnection,
  familyId: string,
  creatorMemberId: string,
) {
  const [rows] = await connection.query<RowDataPacket[]>(
    `SELECT CAST(id AS CHAR) AS id FROM invitations
      WHERE family_id = ? AND created_by_member_id = ?
        AND used_at IS NULL AND revoked_at IS NULL
      ORDER BY id ASC`,
    [familyId, creatorMemberId],
  );
  return rows.map((row) => String(row.id));
}

async function assertCanListFamily(
  connection: PoolConnection,
  actor: Phase1CActor,
  familyId: string,
) {
  const [rows] = await connection.query<RowDataPacket[]>(
    `SELECT am.role FROM family_members am
      JOIN users au ON au.id = am.user_id
      JOIN sessions s ON s.id = ? AND s.user_id = am.user_id
      WHERE am.family_id = ? AND am.user_id = ?
        AND am.disabled_at IS NULL AND am.left_at IS NULL
        AND au.disabled_at IS NULL
        AND s.client_type = 'WEB' AND s.token_hash = ?
        AND s.revoked_at IS NULL AND s.expires_at > CURRENT_TIMESTAMP(3)
        AND DATE_ADD(s.last_seen_at, INTERVAL 7 DAY) > CURRENT_TIMESTAMP(3)
      LIMIT 1`,
    [actor.sessionId, familyId, actor.userId, actor.tokenHash],
  );
  const role = rows[0]?.role as FamilyRole | undefined;
  if (!role) throw new Phase1CRepositoryError("NOT_FOUND");
  if (!canListInvitations(role)) throw new Phase1CRepositoryError("FORBIDDEN");
}

function compareIds(left: string, right: string) {
  return BigInt(left) < BigInt(right)
    ? -1
    : BigInt(left) > BigInt(right)
      ? 1
      : 0;
}

function isUsernameDuplicate(error: unknown) {
  if (!error || typeof error !== "object") return false;
  const candidate = error as { code?: string; message?: string };
  return (
    candidate.code === "ER_DUP_ENTRY" &&
    candidate.message?.includes("uq_users_username_normalized") === true
  );
}
