import type { Pool, PoolConnection, RowDataPacket } from "mysql2/promise";

import { validateDatabaseHealth } from "./health.js";
import { runTransaction } from "./transaction.js";

export async function acquireCheckedConnection(
  pool: Pool,
): Promise<PoolConnection> {
  const connection = await pool.getConnection();
  try {
    await connection.query("SET SESSION time_zone = '+00:00'");
    await validateDatabaseHealth(connection);
    const [rows] = await connection.query<RowDataPacket[]>(
      "SELECT @@SESSION.time_zone AS timeZone, @@SESSION.sql_mode AS sqlMode",
    );
    const row = rows[0];
    if (!row || row.timeZone !== "+00:00") {
      throw new Error("DB_UTC_REQUIRED: @@SESSION.time_zone must be +00:00");
    }
    if (
      !String(row.sqlMode)
        .split(",")
        .some((mode) => mode.startsWith("STRICT_"))
    ) {
      throw new Error(
        "DB_STRICT_MODE_REQUIRED: strict SQL mode must be enabled",
      );
    }
    return connection;
  } catch (error) {
    connection.release();
    throw error;
  }
}

export function runCheckedTransaction<T>(
  pool: Pool,
  operation: (connection: PoolConnection) => Promise<T>,
): Promise<T> {
  return runTransaction(pool, operation, {
    acquire: () => acquireCheckedConnection(pool),
  });
}

export async function readServerTime(
  connection: Pick<PoolConnection, "query">,
): Promise<Date> {
  const [rows] = await connection.query<RowDataPacket[]>(
    "SELECT CURRENT_TIMESTAMP(3) AS serverNow",
  );
  const serverNow = rows[0]?.serverNow;
  if (!(serverNow instanceof Date)) {
    throw new Error("Database server time is unavailable.");
  }
  return serverNow;
}
