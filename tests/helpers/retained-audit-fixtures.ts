import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import {
  acquireCheckedConnection,
  createDatabase,
  runCheckedTransaction,
  type RowDataPacket,
} from "../../packages/db/src/index.js";
import { assertNoPhase11DevInstances } from "../../packages/db/scripts/phase11-instance-proof.js";
import { verifyRetiredControlFixtures } from "./retired-control-fixtures.js";

type PoolConnection = Awaited<ReturnType<typeof acquireCheckedConnection>>;

const file = resolve(".cache/phase11-r1/retained-audit-fixtures.json");
type Retained = { familyId: string; name: string; digest: string };
const records = (): Retained[] =>
  existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : [];
const businessTables = [
  "upload_album_targets",
  "purge_files",
  "media_location_projections",
  "album_media",
  "album_members",
  "invitations",
  "derived_assets",
  "background_jobs",
  "media_items",
  "upload_sessions",
  "storage_objects",
  "albums",
] as const;
async function identity(c: PoolConnection, familyId: string) {
  const data: unknown[] = [];
  for (const table of [
    "families",
    "family_members",
    "audit_logs",
    "purge_intents",
    "purge_files",
  ] as const) {
    const [rows] = await c.query<RowDataPacket[]>(
      `SELECT * FROM ${table} WHERE ${table === "families" ? "id" : "family_id"}=? ORDER BY id`,
      [familyId],
    );
    data.push(rows);
  }
  const [users] = await c.query<RowDataPacket[]>(
    "SELECT CAST(u.id AS CHAR) id,u.username FROM users u JOIN family_members fm ON fm.user_id=u.id WHERE fm.family_id=? ORDER BY u.id",
    [familyId],
  );
  data.push(users);
  return createHash("sha256").update(JSON.stringify(data)).digest("hex");
}
/** Read-only allowlist of this invocation's exact retired synthetic audit graph.
 * It does not authorize another account, deployment, media row or live job. */
export async function verifyRetainedAuditFixtures(c: PoolConnection) {
  const retained = records();
  const ids = new Set<string>();
  for (const item of retained) {
    if (
      !/^(?:p8-runtime-|p10_)[0-9a-f]{32}$/.test(item.name) ||
      ids.has(item.familyId)
    )
      throw Error("RETAINED_AUDIT_IDENTITY_INVALID");
    const [family] = await c.query<RowDataPacket[]>(
      "SELECT name FROM families WHERE id=?",
      [item.familyId],
    );
    if (
      family[0]?.name !== item.name ||
      (await identity(c, item.familyId)) !== item.digest
    )
      throw Error("RETAINED_AUDIT_GRAPH_CHANGED");
    for (const table of businessTables.filter((t) => t !== "purge_files")) {
      const [rows] = await c.query<RowDataPacket[]>(
        `SELECT COUNT(*) n FROM ${table} WHERE family_id=?`,
        [item.familyId],
      );
      if (String(rows[0]?.n) !== "0")
        throw Error("RETAINED_AUDIT_LIVE_BUSINESS_PRESENT");
    }
    const [active] = await c.query<RowDataPacket[]>(
      "SELECT (SELECT COUNT(*) FROM purge_intents WHERE family_id=? AND (progress<>'COMPLETED' OR execution_state<>'DONE')) purges,(SELECT COUNT(*) FROM sessions s JOIN family_members fm ON fm.user_id=s.user_id WHERE fm.family_id=?) sessions,(SELECT COUNT(*) FROM system_admin_grants WHERE family_id=?) grants",
      [item.familyId, item.familyId, item.familyId],
    );
    if (Object.values(active[0]!).some((n) => String(n) !== "0"))
      throw Error("RETAINED_AUDIT_LIVE_CAPABILITY_PRESENT");
    ids.add(item.familyId);
  }
  for (const id of (await verifyRetiredControlFixtures(c)).families)
    ids.add(id);
  return ids;
}
/** Remove only a proved synthetic family's disposable business fixtures.
 * Audit records and their FK ancestors remain in DEV, unchanged and hash-bound. */
export async function cleanupOwnedFamilyRetainingAudit(
  familyId: string,
  name: string,
  userIds: readonly string[],
) {
  if (!/^(?:p8-runtime-|p10_)[0-9a-f]{32}$/.test(name))
    throw Error("OWNED_AUDIT_NONCE_REQUIRED");
  const url = process.env.DATABASE_URL;
  if (!url) throw Error("OWNED_CLEANUP_DEV_DATABASE_REQUIRED");
  const target = new URL(url);
  if (
    target.pathname !== "/family_album_dev" ||
    target.username.toLowerCase() === "root"
  )
    throw Error("OWNED_CLEANUP_DEV_DATABASE_REQUIRED");
  // Caller has joined every application/callback and closed its fixture pool.
  // This fresh single connection keeps the no-other-connection proof exact.
  const cleanup = createDatabase(url),
    pool = cleanup.pool;
  try {
    const check = await acquireCheckedConnection(pool);
    try {
      await assertNoPhase11DevInstances(check, process.cwd());
    } finally {
      check.release();
    }
    const digest = await runCheckedTransaction(pool, async (c) => {
      const [family] = await c.query<RowDataPacket[]>(
        "SELECT name FROM families WHERE id=? FOR UPDATE",
        [familyId],
      );
      if (family[0]?.name !== name) throw Error("OWNED_AUDIT_FAMILY_CHANGED");
      if (!userIds.length || new Set(userIds).size !== userIds.length)
        throw Error("OWNED_AUDIT_USERS_CHANGED");
      const suffix = name.replace(/^(?:p8-runtime-|p10_)/, "");
      const allowedNames = name.startsWith("p8-runtime-")
        ? [`p8pipe_${suffix}`, `p8second_${suffix}`]
        : [`p10_${suffix}`, `p10_other_${suffix}`, `p10_invited_${suffix}`];
      const [users] = await c.query<RowDataPacket[]>(
        `SELECT CAST(id AS CHAR) id,username FROM users WHERE id IN (${userIds.map(() => "?").join(",")}) ORDER BY id FOR UPDATE`,
        [...userIds],
      );
      if (
        users.length !== userIds.length ||
        users.some((u) => !allowedNames.includes(String(u.username)))
      )
        throw Error("OWNED_AUDIT_USERS_CHANGED");
      const [members] = await c.query<RowDataPacket[]>(
        "SELECT CAST(user_id AS CHAR) userId FROM family_members WHERE family_id=? ORDER BY user_id FOR UPDATE",
        [familyId],
      );
      if (
        members.length !== userIds.length ||
        members.some((m) => !userIds.includes(String(m.userId)))
      )
        throw Error("OWNED_AUDIT_USERS_CHANGED");
      const [purges] = await c.query<RowDataPacket[]>(
        "SELECT id,progress,execution_state FROM purge_intents WHERE family_id=? FOR UPDATE",
        [familyId],
      );
      if (
        purges.some(
          (p) => p.progress !== "COMPLETED" || p.execution_state !== "DONE",
        )
      )
        throw Error("OWNED_AUDIT_PURGE_UNSETTLED");
      for (const table of businessTables.filter((t) => t !== "purge_files")) {
        const [rows] = await c.query<RowDataPacket[]>(
          `SELECT CAST(id AS CHAR) id FROM ${table} WHERE family_id=? FOR UPDATE`,
          [familyId],
        );
        for (const row of rows)
          await c.query(`DELETE FROM ${table} WHERE id=? AND family_id=?`, [
            row.id,
            familyId,
          ]);
      }
      for (const id of userIds)
        await c.query("DELETE FROM sessions WHERE user_id=?", [id]);
      return identity(c, familyId);
    });
    const retained = records();
    if (retained.some((r) => r.familyId === familyId))
      throw Error("OWNED_AUDIT_ALREADY_RETAINED");
    retained.push({ familyId, name, digest });
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(retained, null, 2), { mode: 0o600 });
  } finally {
    await cleanup.pool.end();
  }
}
