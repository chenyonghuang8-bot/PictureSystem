import type {
  Pool,
  PoolConnection,
  ResultSetHeader,
  RowDataPacket,
} from "mysql2/promise";

import { acquireCheckedConnection, readServerTime } from "./connection.js";
import {
  assertMigrationReadiness,
  MigrationReadinessError,
} from "./migration-readiness.js";
import { runTransaction } from "./transaction.js";

const BOOTSTRAP_LOCK = "family_album_dev.bootstrap.v1";
export class BootstrapRejectedError extends Error {
  constructor(readonly reason: string) {
    super("Bootstrap was rejected.");
    this.name = "BootstrapRejectedError";
  }
}

export async function bootstrapIdentity(
  pool: Pool,
  input: {
    familyName: string;
    username: string;
    usernameNormalized: Buffer;
    passwordHash: string;
    displayName: string | null;
  },
) {
  let cleanupWarning = false;
  const result = await runTransaction(
    pool,
    async (connection) => {
      await assertBootstrapDatabase(connection);
      const now = await readServerTime(connection);
      const [family] = await connection.query<ResultSetHeader>(
        `INSERT INTO families (name, created_at, updated_at) VALUES (?, ?, ?)`,
        [input.familyName, now, now],
      );
      const familyId = String(family.insertId);
      const [user] = await connection.query<ResultSetHeader>(
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
      const userId = String(user.insertId);
      const [member] = await connection.query<ResultSetHeader>(
        `INSERT INTO family_members
          (family_id, user_id, role, joined_at, updated_at)
         VALUES (?, ?, 'SUPER_ADMIN', ?, ?)`,
        [familyId, userId, now, now],
      );
      return {
        familyId,
        userId,
        memberId: String(member.insertId),
        cleanupWarning: false,
      };
    },
    {
      acquire: () => acquireBootstrapConnection(pool),
      release: async (connection) => {
        const released = await releaseBootstrapLock(connection);
        cleanupWarning ||= !released;
      },
      destroy: async (connection) => {
        connection.destroy();
      },
    },
  );
  result.cleanupWarning = cleanupWarning;
  return result;
}

async function acquireBootstrapConnection(pool: Pool) {
  const connection = await acquireCheckedConnection(pool);
  try {
    const [rows] = await connection.query<RowDataPacket[]>(
      "SELECT GET_LOCK(?, 5) AS acquired",
      [BOOTSTRAP_LOCK],
    );
    if (String(rows[0]?.acquired) !== "1") {
      throw new BootstrapRejectedError("LOCK_UNAVAILABLE");
    }
    return connection;
  } catch (error) {
    connection.destroy();
    throw error;
  }
}

async function releaseBootstrapLock(connection: PoolConnection) {
  try {
    const [rows] = await connection.query<RowDataPacket[]>(
      "SELECT RELEASE_LOCK(?) AS released",
      [BOOTSTRAP_LOCK],
    );
    if (String(rows[0]?.released) !== "1") {
      connection.destroy();
      return false;
    }
    connection.release();
    return true;
  } catch {
    connection.destroy();
    return false;
  }
}

async function assertBootstrapDatabase(connection: PoolConnection) {
  const [identityRows] = await connection.query<RowDataPacket[]>(
    "SELECT DATABASE() AS databaseName, CURRENT_USER() AS currentUser",
  );
  const identity = identityRows[0];
  if (identity?.databaseName !== "family_album_dev") {
    throw new BootstrapRejectedError("WRONG_DATABASE");
  }
  const currentUser = identity?.currentUser;
  if (typeof currentUser !== "string" || !currentUser.includes("@")) {
    throw new BootstrapRejectedError("DATABASE_IDENTITY_UNAVAILABLE");
  }
  if (currentUser.toLowerCase().startsWith("root@")) {
    throw new BootstrapRejectedError("ROOT_DATABASE_USER");
  }

  try {
    await assertMigrationReadiness(connection);
  } catch (error) {
    if (!(error instanceof MigrationReadinessError)) throw error;
    throw new BootstrapRejectedError("MIGRATION_NOT_READY");
  }

  const [counts] = await connection.query<RowDataPacket[]>(
    `SELECT
       (SELECT COUNT(*) FROM users) AS users,
       (SELECT COUNT(*) FROM families) AS families,
       (SELECT COUNT(*) FROM family_members) AS members`,
  );
  const countsRow = counts[0];
  if (
    String(countsRow?.users) !== "0" ||
    String(countsRow?.families) !== "0" ||
    String(countsRow?.members) !== "0"
  ) {
    throw new BootstrapRejectedError("DATABASE_NOT_EMPTY");
  }
}
