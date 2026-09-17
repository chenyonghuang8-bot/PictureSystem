import type { Connection, RowDataPacket } from "mysql2/promise";

export async function validateDatabaseHealth(
  connection: Pick<Connection, "query">,
) {
  const [rows] = await connection.query<RowDataPacket[]>(
    "SELECT @@GLOBAL.innodb_native_foreign_keys AS nativeFk, @@SESSION.foreign_key_checks AS foreignKeyChecks",
  );
  const row = rows[0];
  if (!row || String(row.nativeFk) !== "1") {
    throw new Error(
      "DB_NATIVE_FK_REQUIRED: @@GLOBAL.innodb_native_foreign_keys must be 1",
    );
  }
  if (String(row.foreignKeyChecks) !== "1") {
    throw new Error(
      "DB_FK_CHECKS_REQUIRED: @@SESSION.foreign_key_checks must be 1",
    );
  }
  return { nativeFk: true, foreignKeyChecks: true } as const;
}
