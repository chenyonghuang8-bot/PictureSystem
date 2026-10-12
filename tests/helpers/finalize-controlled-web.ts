import {
  closeSync,
  fsyncSync,
  openSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { createHash } from "node:crypto";
import {
  acquireCheckedConnection,
  assertMigrationReadiness,
  createDatabase,
  type RowDataPacket,
} from "../../packages/db/src/index.js";
import { awaitControlledWebNoInstances } from "./controlled-web-runtime.js";
import { DevControlHarness } from "./dev-control-harness.js";
import { verifyRetainedAuditFixtures } from "./retained-audit-fixtures.js";
import {
  cleanupWebAcceptanceStorage,
  assertOwnedWebAcceptanceStorage,
  type WebAcceptanceStorage,
} from "../e2e-web/storage-harness.js";

export type WebClosureReceipt = {
  version: 1;
  state:
    | "CLOSED_AWAITING_INSTANCE_PROOF"
    | "FINALIZING"
    | "BASELINE_RESTORED"
    | "FINALIZED";
  capturedAtUTC: string;
  deploymentId: string;
  runId: string;
  cleanAt: Date | string;
  roles: string[];
  childExitCodes: (number | null)[];
  storage: WebAcceptanceStorage;
  finalizedAtUTC?: string;
};
export function webClosureReceiptPath(value?: string) {
  const directory = resolve(".cache/phase11-current");
  if (
    !value ||
    dirname(value) !== directory ||
    !/^web-closure-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.json$/.test(
      value.slice(directory.length + 1),
    )
  )
    throw Error("WEB_OUTER_FINALIZATION_RECEIPT_REQUIRED");
  return value;
}
export function writeWebClosureReceipt(path: string, value: WebClosureReceipt) {
  webClosureReceiptPath(path);
  const temporary = path + ".tmp";
  writeFileSync(temporary, JSON.stringify(value, null, 2), {
    flag: "wx",
    mode: 0o600,
  });
  const file = openSync(temporary, "r");
  try {
    fsyncSync(file);
  } finally {
    closeSync(file);
  }
  renameSync(temporary, path);
  const directory = openSync(dirname(path), "r");
  try {
    fsyncSync(directory);
  } finally {
    closeSync(directory);
  }
}

/** Runs only after the Playwright CLI has exited. No loader/worker exception
 * is added to the existing strict no-instance proof. */
export async function finalizeControlledWebFixture(
  path: string,
  options: { recoveredOperationIds?: readonly string[] } = {},
) {
  webClosureReceiptPath(path);
  const receipt = JSON.parse(readFileSync(path, "utf8")) as WebClosureReceipt;
  if (
    receipt.version !== 1 ||
    receipt.state !== "CLOSED_AWAITING_INSTANCE_PROOF" ||
    receipt.childExitCodes[0] !== 0 ||
    (receipt.roles.includes("METADATA") && receipt.childExitCodes[1] !== 0)
  )
    throw Error("WEB_CLOSURE_NOT_FINALIZABLE");
  const target = new URL(process.env.DATABASE_URL!);
  if (
    target.pathname !== "/family_album_dev" ||
    target.username.toLowerCase() === "root"
  )
    throw Error("WEB_FINALIZATION_DEV_REQUIRED");
  const db = createDatabase(process.env.DATABASE_URL!);
  try {
    const c = await acquireCheckedConnection(db.pool);
    try {
      await assertMigrationReadiness(c);
      await awaitControlledWebNoInstances(c);
      const [runs] = await c.query<RowDataPacket[]>(
        "SELECT r.* FROM system_control c JOIN system_control_runs r ON r.id=c.current_run_id LEFT JOIN system_control_operations o ON o.id=c.active_operation_id WHERE c.id=1 AND c.deployment_id=? AND c.requested_mode='READ_ONLY' AND c.enforced_mode='READ_ONLY' AND c.transition_state='STABLE' AND c.fault_latched=0 AND c.revision=r.clean_revision AND c.health_generation=r.clean_health_generation AND (c.active_operation_id IS NULL OR (o.status='APPLIED' AND o.result_revision IS NOT NULL AND o.result_revision<=c.revision)) AND r.id=? AND r.phase='CLEAN'",
        [receipt.deploymentId, receipt.runId],
      );
      const run = runs[0];
      const digest = createHash("sha256")
        .update(
          JSON.stringify({
            protocol: 1,
            mediaRoot: receipt.storage.mediaRoot,
            markerId: receipt.storage.markerId,
            expectedRoles: receipt.roles,
            ownerRole: "API",
          }),
        )
        .digest();
      if (
        runs.length !== 1 ||
        new Date(run!.clean_at).toISOString() !==
          new Date(receipt.cleanAt).toISOString() ||
        String(run!.expected_roles) !== receipt.roles.join(",") ||
        !Buffer.isBuffer(run!.config_digest) ||
        !digest.equals(run!.config_digest)
      )
        throw Error("WEB_CLOSURE_RUN_IDENTITY_CHANGED");
      const [pending] = await c.query<RowDataPacket[]>(
        "SELECT COUNT(*) n FROM system_control_operations WHERE status='PENDING'",
      );
      if (String(pending[0]?.n) !== "0")
        throw Error("WEB_CLOSURE_PENDING_OPERATION_RETAINED");
      const retired = await verifyRetainedAuditFixtures(c);
      const manifest = JSON.parse(
        readFileSync(
          resolve(
            `.cache/phase11-current/api-fixture-${receipt.deploymentId}.json`,
          ),
          "utf8",
        ),
      );
      const [families] = await c.query<RowDataPacket[]>(
        "SELECT CAST(id AS CHAR) id FROM families",
      );
      if (
        families.some(
          (f) =>
            String(f.id) !== manifest.familyId && !retired.has(String(f.id)),
        )
      )
        throw Error("WEB_CONTROL_WORKER_FAMILY_REMAINS");
      for (const table of [
        "albums",
        "album_media",
        "album_members",
        "comments",
        "tags",
        "media_tags",
        "user_favorites",
        "family_featured",
        "invitations",
        "shares",
        "share_events",
        "media_location_projections",
        "derived_assets",
        "background_jobs",
        "media_items",
        "upload_album_targets",
        "upload_sessions",
        "storage_objects",
      ]) {
        const [rows] = await c.query<RowDataPacket[]>(
          `SELECT COUNT(*) n FROM ${table}`,
        );
        if (String(rows[0]?.n) !== "0")
          throw Error("WEB_CONTROL_WORKER_BUSINESS_REMAINS");
      }
      const [capabilities] = await c.query<RowDataPacket[]>(
        "SELECT (SELECT COUNT(*) FROM users u WHERE NOT EXISTS(SELECT 1 FROM family_members m WHERE m.user_id=u.id)) orphanUsers,(SELECT COUNT(*) FROM sessions WHERE user_id<>?) otherSessions,(SELECT COUNT(*) FROM system_admin_grants WHERE user_id<>? OR family_id<>?) otherGrants,(SELECT COUNT(*) FROM purge_intents WHERE execution_state<>'DONE' OR progress<>'COMPLETED') unfinishedPurges",
        [manifest.userId, manifest.userId, manifest.familyId],
      );
      if (Object.values(capabilities[0]!).some((v) => String(v) !== "0"))
        throw Error("WEB_CONTROL_WORKER_CAPABILITY_REMAINS");
    } finally {
      c.release();
    }
    // Validate the real owned directory before clearing any control identity.
    assertOwnedWebAcceptanceStorage(receipt.storage);
    const ownership = JSON.parse(
      readFileSync(
        resolve(receipt.storage.runRoot, ".picturesystem-web-e2e-owner.json"),
        "utf8",
      ),
    );
    if (ownership.ownershipNonce !== receipt.storage.ownershipNonce)
      throw Error("WEB_CLOSURE_STORAGE_OWNER_CHANGED");
    const marker = readFileSync(
      resolve(receipt.storage.mediaRoot, ".storage-root"),
      "utf8",
    );
    if (
      !marker.startsWith(`FAMILY_ALBUM_STORAGE_V2:${receipt.storage.markerId}:`)
    )
      throw Error("WEB_CLOSURE_STORAGE_MARKER_CHANGED");
    const control = await DevControlHarness.resume(
      db.pool,
      receipt.deploymentId,
    );
    writeWebClosureReceipt(path, { ...receipt, state: "FINALIZING" });
    // Unknown/partial outcomes leave FINALIZING and cannot be replayed here.
    await control.cleanup(options.recoveredOperationIds ?? []);
    writeWebClosureReceipt(path, { ...receipt, state: "BASELINE_RESTORED" });
    cleanupWebAcceptanceStorage(receipt.storage);
    writeWebClosureReceipt(path, {
      ...receipt,
      state: "FINALIZED",
      finalizedAtUTC: new Date().toISOString(),
    });
  } finally {
    await db.pool.end();
  }
}
