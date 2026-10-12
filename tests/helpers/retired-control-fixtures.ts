import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import type {
  acquireCheckedConnection,
  RowDataPacket,
} from "../../packages/db/src/index.js";
type PoolConnection = Awaited<ReturnType<typeof acquireCheckedConnection>>;

// Offline DEV fixture evidence only. Production admission never reads this file.
export const retiredControlRegistry = resolve(
  ".cache/phase11-r1/retired-control-fixtures.json",
);
const keys = {
  families: "id",
  users: "id",
  family_members: "id",
  system_control_operations: "id",
  system_control_runs: "id",
  system_control_run_members: "run_id",
  admin_runtime_observations: "boot_id",
  admin_audit_events: "id",
  audit_logs: "id",
  purge_intents: "id",
  purge_files: "id",
} as const;
export type RetiredTable = keyof typeof keys;
export type RetiredSnapshot = {
  table: RetiredTable;
  ids: string[];
  count: number;
  digest: string;
};
export function retiredDigest(rows: unknown) {
  return createHash("sha256").update(JSON.stringify(rows)).digest("hex");
}
export async function retiredRows(
  c: PoolConnection,
  table: RetiredTable,
  ids: readonly string[],
) {
  if (
    !Object.hasOwn(keys, table) ||
    ids.length > 10000 ||
    new Set(ids).size !== ids.length ||
    ids.some((id) => !/^[0-9a-f-]+$/.test(id))
  )
    throw Error("RETIRED_CONTROL_SELECTOR_INVALID");
  if (!ids.length) return [];
  const columns = table === "users" ? "CAST(id AS CHAR) id,username" : "*";
  const order =
    table === "system_control_run_members" ? "run_id,role" : keys[table];
  const [rows] = await c.query<RowDataPacket[]>(
    `SELECT ${columns} FROM ${table} WHERE ${keys[table]} IN (${ids.map(() => "?").join(",")}) ORDER BY ${order}`,
    [...ids],
  );
  return rows;
}
export async function verifyRetiredControlFixtures(
  c: PoolConnection,
  registryPath = retiredControlRegistry,
) {
  const families = new Set<string>(),
    operations = new Set<string>();
  if (!existsSync(registryPath)) return { families, operations };
  const records: {
    retirementId: string;
    status: string;
    snapshots: RetiredSnapshot[];
  }[] = JSON.parse(readFileSync(registryPath, "utf8"));
  if (!Array.isArray(records) || records.length > 8)
    throw Error("RETIRED_CONTROL_REGISTRY_INVALID");
  for (const record of records) {
    if (
      record.status !== "COMMITTED" ||
      !/^[0-9a-f-]{36}$/.test(record.retirementId) ||
      !Array.isArray(record.snapshots) ||
      record.snapshots.length !== Object.keys(keys).length ||
      new Set(record.snapshots.map((s) => s.table)).size !==
        Object.keys(keys).length
    )
      throw Error("RETIRED_CONTROL_REGISTRY_INVALID");
    const [event] = await c.query<RowDataPacket[]>(
      "SELECT id FROM admin_audit_events WHERE operation_id=? AND action='OUTCOME_OBSERVED' AND scope='SYSTEM' AND result_category='RECOVERY_REQUIRED'",
      [record.retirementId],
    );
    if (event.length !== 1) throw Error("RETIRED_CONTROL_COMMIT_UNCONFIRMED");
    for (const snapshot of record.snapshots) {
      const rows = await retiredRows(c, snapshot.table, snapshot.ids);
      if (
        rows.length !== snapshot.count ||
        retiredDigest(rows) !== snapshot.digest
      )
        throw Error("RETIRED_CONTROL_HISTORY_CHANGED");
      if (snapshot.table === "families")
        for (const id of snapshot.ids) families.add(id);
      if (snapshot.table === "system_control_operations")
        for (const id of snapshot.ids) operations.add(id);
    }
  }
  for (const id of families) {
    for (const table of [
      "share_events",
      "shares",
      "upload_album_targets",
      "comments",
      "media_tags",
      "tags",
      "user_favorites",
      "family_featured",
      "media_location_projections",
      "album_members",
      "invitations",
      "derived_assets",
      "media_items",
      "storage_objects",
      "upload_sessions",
      "background_jobs",
      "albums",
      "album_media",
      "system_admin_grants",
    ]) {
      const [rows] = await c.query<RowDataPacket[]>(
        `SELECT COUNT(*) n FROM ${table} WHERE family_id=?`,
        [id],
      );
      if (String(rows[0]?.n) !== "0")
        throw Error("RETIRED_CONTROL_LIVE_CAPABILITY_PRESENT");
    }
    const [sessions] = await c.query<RowDataPacket[]>(
      "SELECT COUNT(*) n FROM sessions s JOIN family_members m ON m.user_id=s.user_id WHERE m.family_id=?",
      [id],
    );
    if (String(sessions[0]?.n) !== "0")
      throw Error("RETIRED_CONTROL_LIVE_CAPABILITY_PRESENT");
    const [purges] = await c.query<RowDataPacket[]>(
      "SELECT COUNT(*) n FROM purge_intents WHERE family_id=? AND (progress<>'COMPLETED' OR execution_state<>'DONE')",
      [id],
    );
    if (String(purges[0]?.n) !== "0")
      throw Error("RETIRED_CONTROL_LIVE_CAPABILITY_PRESENT");
  }
  return { families, operations };
}
