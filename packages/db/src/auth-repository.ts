import type {
  Pool,
  PoolConnection,
  ResultSetHeader,
  RowDataPacket,
} from "mysql2/promise";

import {
  acquireCheckedConnection,
  readServerTime,
  runCheckedTransaction,
} from "./connection.js";

export type LoginUser = {
  id: string;
  passwordHash: string;
  disabledAt: Date | null;
};

export type SessionIdentity = {
  sessionId: string;
  userId: string;
  username: string;
  displayName: string | null;
  passwordHash: string;
  clientType: "WEB" | "ANDROID";
  authenticatedAt: Date;
  createdAt: Date;
  lastSeenAt: Date;
  expiresAt: Date;
  revokedAt: Date | null;
  disabledAt: Date | null;
  serverNow: Date;
};

export type Membership = {
  id: string;
  familyId: string;
  familyName: string;
  role: "SUPER_ADMIN" | "ADMIN" | "MEMBER";
};

export type SessionRecord = {
  id: string;
  clientType: "WEB" | "ANDROID";
  deviceLabel: string | null;
  authenticatedAt: Date;
  createdAt: Date;
  lastSeenAt: Date;
  expiresAt: Date;
};

export class AuthRepositoryStateError extends Error {
  constructor(
    readonly reason:
      | "INVALID_CREDENTIALS"
      | "UNAUTHENTICATED"
      | "CONFLICT"
      | "RECENT_AUTH_REQUIRED",
  ) {
    super(reason);
    this.name = "AuthRepositoryStateError";
  }
}

type UserRow = RowDataPacket & {
  id: string;
  passwordHash: string;
  disabledAt: Date | null;
};

type SessionRow = RowDataPacket & SessionIdentity;

async function inTransaction<T>(
  pool: Pool,
  operation: (connection: PoolConnection) => Promise<T>,
): Promise<T> {
  return runCheckedTransaction(pool, operation);
}

async function getServerNow(connection: PoolConnection): Promise<Date> {
  return readServerTime(connection);
}

async function lockUserSessionsInIdOrder(
  connection: PoolConnection,
  userId: string,
  selectedIds?: readonly string[],
): Promise<RowDataPacket[]> {
  let ids: string[];
  if (selectedIds) {
    ids = [...new Set(selectedIds)].sort((left, right) =>
      BigInt(left) < BigInt(right) ? -1 : BigInt(left) > BigInt(right) ? 1 : 0,
    );
  } else {
    const [listed] = await connection.query<RowDataPacket[]>(
      `SELECT CAST(id AS CHAR) AS id FROM sessions
        WHERE user_id = ? ORDER BY id ASC`,
      [userId],
    );
    ids = listed.map((row) => String(row.id));
  }

  const locked: RowDataPacket[] = [];
  for (const id of ids) {
    const [rows] = await connection.query<RowDataPacket[]>(
      `SELECT CAST(id AS CHAR) AS id, token_hash AS tokenHash,
              revoked_at AS revokedAt, expires_at AS expiresAt,
              last_seen_at AS lastSeenAt, authenticated_at AS authenticatedAt
         FROM sessions
        WHERE user_id = ? AND id = ? FOR UPDATE`,
      [userId, id],
    );
    if (rows[0]) locked.push(rows[0]);
  }
  return locked;
}

export class MySqlAuthRepository {
  constructor(private readonly pool: Pool) {}

  async findLoginUser(usernameNormalized: Buffer): Promise<LoginUser | null> {
    const connection = await acquireCheckedConnection(this.pool);
    try {
      const [rows] = await connection.query<UserRow[]>(
        `SELECT CAST(id AS CHAR) AS id, password_hash AS passwordHash,
                disabled_at AS disabledAt
           FROM users
          WHERE username_normalized = ?
          LIMIT 1`,
        [usernameNormalized],
      );
      return rows[0] ?? null;
    } finally {
      connection.release();
    }
  }

  async issueLoginSession(input: {
    userId: string;
    expectedPasswordHash: string;
    replacementPasswordHash?: string;
    tokenHash: Buffer;
    deviceLabel: string | null;
  }): Promise<{ sessionId: string; expiresAt: Date; serverNow: Date }> {
    return inTransaction(this.pool, async (connection) => {
      const [users] = await connection.query<UserRow[]>(
        `SELECT CAST(id AS CHAR) AS id, password_hash AS passwordHash,
                disabled_at AS disabledAt
           FROM users WHERE id = ? FOR UPDATE`,
        [input.userId],
      );
      const user = users[0];
      if (
        !user ||
        user.disabledAt ||
        user.passwordHash !== input.expectedPasswordHash
      ) {
        throw new AuthRepositoryStateError("INVALID_CREDENTIALS");
      }

      await lockUserSessionsInIdOrder(connection, input.userId);

      const [memberships] = await connection.query<RowDataPacket[]>(
        `SELECT id FROM family_members
          WHERE user_id = ? AND disabled_at IS NULL AND left_at IS NULL
          ORDER BY id ASC FOR SHARE`,
        [input.userId],
      );
      if (!memberships[0]) {
        throw new AuthRepositoryStateError("INVALID_CREDENTIALS");
      }

      if (input.replacementPasswordHash) {
        const [updated] = await connection.query<ResultSetHeader>(
          `UPDATE users SET password_hash = ?
            WHERE id = ? AND password_hash = ? AND disabled_at IS NULL`,
          [
            input.replacementPasswordHash,
            input.userId,
            input.expectedPasswordHash,
          ],
        );
        if (updated.affectedRows !== 1) {
          throw new AuthRepositoryStateError("CONFLICT");
        }
      }

      const serverNow = await getServerNow(connection);
      const expiresAt = new Date(serverNow.getTime() + 30 * 24 * 60 * 60_000);
      await connection.query<ResultSetHeader>(
        `INSERT INTO sessions
          (user_id, token_hash, client_type, device_label, authenticated_at,
           created_at, last_seen_at, expires_at)
         VALUES (?, ?, 'WEB', ?, ?, ?, ?, ?)`,
        [
          input.userId,
          input.tokenHash,
          input.deviceLabel,
          serverNow,
          serverNow,
          serverNow,
          expiresAt,
        ],
      );
      const [created] = await connection.query<RowDataPacket[]>(
        "SELECT CAST(LAST_INSERT_ID() AS CHAR) AS sessionId",
      );
      const row = created[0];
      if (!row) throw new Error("Session insert result is unavailable.");
      return {
        sessionId: String(row.sessionId),
        expiresAt,
        serverNow,
      };
    });
  }

  async findSession(tokenHash: Buffer): Promise<SessionIdentity | null> {
    const connection = await acquireCheckedConnection(this.pool);
    try {
      const [rows] = await connection.query<SessionRow[]>(
        `SELECT CAST(s.id AS CHAR) AS sessionId, CAST(s.user_id AS CHAR) AS userId,
                u.username, u.display_name AS displayName,
                u.password_hash AS passwordHash, s.client_type AS clientType,
                s.authenticated_at AS authenticatedAt, s.created_at AS createdAt,
                s.last_seen_at AS lastSeenAt, s.expires_at AS expiresAt,
                s.revoked_at AS revokedAt, u.disabled_at AS disabledAt,
                CURRENT_TIMESTAMP(3) AS serverNow
           FROM sessions s JOIN users u ON u.id = s.user_id
          WHERE s.token_hash = ? LIMIT 1`,
        [tokenHash],
      );
      return rows[0] ?? null;
    } finally {
      connection.release();
    }
  }

  async touchSession(input: {
    sessionId: string;
    userId: string;
    tokenHash: Buffer;
  }): Promise<void> {
    return inTransaction(this.pool, async (connection) => {
      await this.lockEnabledUser(connection, input.userId);
      const [rows] = await connection.query<RowDataPacket[]>(
        `SELECT token_hash AS tokenHash, client_type AS clientType,
                revoked_at AS revokedAt, expires_at AS expiresAt,
                last_seen_at AS lastSeenAt
           FROM sessions WHERE id = ? AND user_id = ? FOR UPDATE`,
        [input.sessionId, input.userId],
      );
      const session = rows[0];
      const serverNow = await getServerNow(connection);
      this.assertLockedSession(session, input.tokenHash, serverNow);
      if (session!.clientType !== "WEB") {
        throw new AuthRepositoryStateError("UNAUTHENTICATED");
      }

      const lastSeenAt = session!.lastSeenAt as Date;
      if (serverNow.getTime() - lastSeenAt.getTime() < 5 * 60_000) return;

      const [updated] = await connection.query<ResultSetHeader>(
        `UPDATE sessions
            SET last_seen_at = GREATEST(last_seen_at, ?)
          WHERE id = ? AND user_id = ? AND token_hash = ?
            AND client_type = 'WEB' AND revoked_at IS NULL
            AND expires_at > ?
            AND DATE_ADD(last_seen_at, INTERVAL 7 DAY) > ?
            AND last_seen_at <= DATE_SUB(?, INTERVAL 5 MINUTE)`,
        [
          serverNow,
          input.sessionId,
          input.userId,
          input.tokenHash,
          serverNow,
          serverNow,
          serverNow,
        ],
      );
      if (updated.affectedRows !== 1) {
        throw new AuthRepositoryStateError("UNAUTHENTICATED");
      }
    });
  }

  async listMemberships(userId: string): Promise<Membership[]> {
    const connection = await acquireCheckedConnection(this.pool);
    try {
      const [rows] = await connection.query<(RowDataPacket & Membership)[]>(
        `SELECT CAST(fm.id AS CHAR) AS id, CAST(fm.family_id AS CHAR) AS familyId,
                f.name AS familyName, fm.role
           FROM family_members fm JOIN families f ON f.id = fm.family_id
          WHERE fm.user_id = ? AND fm.disabled_at IS NULL AND fm.left_at IS NULL
          ORDER BY fm.id ASC LIMIT 100`,
        [userId],
      );
      return rows;
    } finally {
      connection.release();
    }
  }

  async revokeByToken(
    tokenHash: Buffer,
  ): Promise<{ sessionStillAddressable: boolean }> {
    const connection = await acquireCheckedConnection(this.pool);
    try {
      const [updated] = await connection.query<ResultSetHeader>(
        `UPDATE sessions SET revoked_at = CURRENT_TIMESTAMP(3), revoke_reason = 'LOGOUT'
          WHERE token_hash = ? AND client_type = 'WEB' AND revoked_at IS NULL`,
        [tokenHash],
      );
      if (updated.affectedRows === 1) return { sessionStillAddressable: true };
      const [rows] = await connection.query<RowDataPacket[]>(
        "SELECT 1 FROM sessions WHERE token_hash = ? AND client_type = 'WEB' LIMIT 1",
        [tokenHash],
      );
      return { sessionStillAddressable: rows.length === 1 };
    } finally {
      connection.release();
    }
  }

  async listSessions(userId: string): Promise<SessionRecord[]> {
    const connection = await acquireCheckedConnection(this.pool);
    try {
      const [rows] = await connection.query<(RowDataPacket & SessionRecord)[]>(
        `SELECT CAST(id AS CHAR) AS id, client_type AS clientType,
                device_label AS deviceLabel, authenticated_at AS authenticatedAt,
                created_at AS createdAt, last_seen_at AS lastSeenAt,
                expires_at AS expiresAt
           FROM sessions
          WHERE user_id = ? AND revoked_at IS NULL
          ORDER BY created_at DESC, id DESC LIMIT 100`,
        [userId],
      );
      return rows;
    } finally {
      connection.release();
    }
  }

  async revokeOwnSession(input: {
    userId: string;
    callerSessionId: string;
    callerTokenHash: Buffer;
    targetSessionId: string;
  }): Promise<{ revokedCurrent: boolean }> {
    return inTransaction(this.pool, async (connection) => {
      await this.lockEnabledUser(connection, input.userId);
      const rows = await lockUserSessionsInIdOrder(connection, input.userId, [
        input.callerSessionId,
        input.targetSessionId,
      ]);
      const caller = rows.find(
        (row) => String(row.id) === input.callerSessionId,
      );
      const serverNow = await getServerNow(connection);
      this.assertLockedSession(caller, input.callerTokenHash, serverNow);
      const target = rows.find(
        (row) => String(row.id) === input.targetSessionId,
      );
      if (target && target.revokedAt === null) {
        await connection.query<ResultSetHeader>(
          `UPDATE sessions
              SET revoked_at = CURRENT_TIMESTAMP(3), revoke_reason = 'USER_REVOKE'
            WHERE id = ? AND user_id = ? AND revoked_at IS NULL`,
          [input.targetSessionId, input.userId],
        );
      }
      return {
        revokedCurrent: input.targetSessionId === input.callerSessionId,
      };
    });
  }

  async rotateSession(input: {
    userId: string;
    sessionId: string;
    oldTokenHash: Buffer;
    newTokenHash: Buffer;
    expectedPasswordHash: string;
  }): Promise<{ expiresAt: Date; serverNow: Date }> {
    return inTransaction(this.pool, async (connection) => {
      const user = await this.lockEnabledUser(connection, input.userId);
      if (user.passwordHash !== input.expectedPasswordHash) {
        throw new AuthRepositoryStateError("CONFLICT");
      }
      const [rows] = await connection.query<RowDataPacket[]>(
        `SELECT token_hash AS tokenHash, revoked_at AS revokedAt,
                expires_at AS expiresAt, last_seen_at AS lastSeenAt
           FROM sessions WHERE id = ? AND user_id = ? FOR UPDATE`,
        [input.sessionId, input.userId],
      );
      const serverNow = await getServerNow(connection);
      this.assertLockedSession(rows[0], input.oldTokenHash, serverNow);
      await connection.query<ResultSetHeader>(
        `UPDATE sessions
            SET token_hash = ?, authenticated_at = CURRENT_TIMESTAMP(3),
                last_seen_at = CURRENT_TIMESTAMP(3)
          WHERE id = ? AND user_id = ? AND token_hash = ? AND revoked_at IS NULL`,
        [input.newTokenHash, input.sessionId, input.userId, input.oldTokenHash],
      );
      const row = rows[0]!;
      return {
        expiresAt: row.expiresAt as Date,
        serverNow,
      };
    });
  }

  async revokeAll(input: {
    userId: string;
    sessionId: string;
    tokenHash: Buffer;
  }): Promise<void> {
    return inTransaction(this.pool, async (connection) => {
      await this.lockEnabledUser(connection, input.userId);
      const rows = await lockUserSessionsInIdOrder(connection, input.userId);
      const session = rows.find((row) => String(row.id) === input.sessionId);
      const serverNow = await getServerNow(connection);
      this.assertLockedSession(session, input.tokenHash, serverNow);
      const authenticatedAt = session!.authenticatedAt as Date;
      const age = serverNow.getTime() - authenticatedAt.getTime();
      if (age < 0 || age >= 15 * 60_000) {
        throw new AuthRepositoryStateError("RECENT_AUTH_REQUIRED");
      }
      await connection.query<ResultSetHeader>(
        `UPDATE sessions SET revoked_at = CURRENT_TIMESTAMP(3), revoke_reason = 'LOGOUT_ALL'
          WHERE user_id = ? AND revoked_at IS NULL ORDER BY id ASC`,
        [input.userId],
      );
    });
  }

  async changePassword(input: {
    userId: string;
    sessionId: string;
    oldTokenHash: Buffer;
    replacementTokenHash: Buffer;
    expectedPasswordHash: string;
    newPasswordHash: string;
    deviceLabel: string | null;
  }): Promise<{ expiresAt: Date; serverNow: Date }> {
    return inTransaction(this.pool, async (connection) => {
      const user = await this.lockEnabledUser(connection, input.userId);
      if (user.passwordHash !== input.expectedPasswordHash) {
        throw new AuthRepositoryStateError("CONFLICT");
      }
      const sessions = await lockUserSessionsInIdOrder(
        connection,
        input.userId,
      );
      const caller = sessions.find((row) => String(row.id) === input.sessionId);
      const serverNow = await getServerNow(connection);
      this.assertLockedSession(caller, input.oldTokenHash, serverNow);
      const authAge =
        serverNow.getTime() - (caller!.authenticatedAt as Date).getTime();
      if (authAge < 0 || authAge >= 15 * 60_000) {
        throw new AuthRepositoryStateError("RECENT_AUTH_REQUIRED");
      }
      const replacementExpiresAt = new Date(
        serverNow.getTime() + 30 * 24 * 60 * 60_000,
      );
      await connection.query<ResultSetHeader>(
        `UPDATE users
            SET password_hash = ?, password_changed_at = CURRENT_TIMESTAMP(3)
          WHERE id = ? AND password_hash = ? AND disabled_at IS NULL`,
        [input.newPasswordHash, input.userId, input.expectedPasswordHash],
      );
      await connection.query<ResultSetHeader>(
        `UPDATE sessions
            SET revoked_at = CURRENT_TIMESTAMP(3), revoke_reason = 'PASSWORD_CHANGE'
          WHERE user_id = ? AND revoked_at IS NULL ORDER BY id ASC`,
        [input.userId],
      );
      await connection.query<ResultSetHeader>(
        `INSERT INTO sessions
          (user_id, token_hash, client_type, device_label, authenticated_at,
           created_at, last_seen_at, expires_at)
         VALUES (?, ?, 'WEB', ?, ?, ?, ?, ?)`,
        [
          input.userId,
          input.replacementTokenHash,
          input.deviceLabel,
          serverNow,
          serverNow,
          serverNow,
          replacementExpiresAt,
        ],
      );
      return {
        expiresAt: replacementExpiresAt,
        serverNow,
      };
    });
  }

  private async lockEnabledUser(connection: PoolConnection, userId: string) {
    const [users] = await connection.query<UserRow[]>(
      `SELECT CAST(id AS CHAR) AS id, password_hash AS passwordHash,
              disabled_at AS disabledAt
         FROM users WHERE id = ? FOR UPDATE`,
      [userId],
    );
    const user = users[0];
    if (!user || user.disabledAt) {
      throw new AuthRepositoryStateError("UNAUTHENTICATED");
    }
    return user;
  }

  private assertLockedSession(
    row: RowDataPacket | undefined,
    expectedTokenHash: Buffer,
    serverNow: Date,
  ) {
    if (
      !row ||
      row.revokedAt !== null ||
      !Buffer.isBuffer(row.tokenHash) ||
      !row.tokenHash.equals(expectedTokenHash)
    ) {
      throw new AuthRepositoryStateError("UNAUTHENTICATED");
    }
    const now = serverNow.getTime();
    if (
      now >= (row.expiresAt as Date).getTime() ||
      now >= (row.lastSeenAt as Date).getTime() + 7 * 24 * 60 * 60_000
    ) {
      throw new AuthRepositoryStateError("UNAUTHENTICATED");
    }
  }
}
