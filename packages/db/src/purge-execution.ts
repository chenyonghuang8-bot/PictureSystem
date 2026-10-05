import { createHash } from "node:crypto";
import type { PoolConnection, RowDataPacket } from "mysql2/promise";
import {
  lockPurgeNormalization,
  type PurgeNormalizationLease,
} from "./purge-normalization.js";

export type PurgeFile = {
  id: string;
  familyId: string;
  intentId: string;
  fileKind: "ORIGINAL" | "DERIVED";
  storageId: string | null;
  mediaId: string | null;
  sha256Hex: string;
  byteSize: string;
  markerId: string;
  device: string;
  generation: string | null;
  recipeId: number | null;
  kind: "THUMBNAIL" | "PREVIEW" | null;
  jobId: string | null;
  epoch: string | null;
  stage:
    | "CATALOGUED"
    | "QUARANTINED"
    | "UNLINK_ARMED"
    | "REMOVED"
    | "ABSENT_DERIVED";
  slotHex: string | null;
  quarantineDevice: string | null;
  quarantineInode: string | null;
};
export function purgeSlot(intentId: string, fileId: string) {
  const slot = Buffer.alloc(16);
  slot.writeBigUInt64BE(BigInt(intentId));
  slot.writeBigUInt64BE(BigInt(fileId), 8);
  return slot;
}
export function purgeIdentity(
  file: Omit<
    PurgeFile,
    "id" | "stage" | "slotHex" | "quarantineDevice" | "quarantineInode"
  >,
) {
  return createHash("sha256")
    .update(`PictureSystem.purge.v1.${file.fileKind}\0`)
    .update(
      JSON.stringify([
        file.familyId,
        file.intentId,
        file.storageId,
        file.mediaId,
        file.sha256Hex,
        file.byteSize,
        file.markerId,
        file.device,
        file.generation,
        file.recipeId,
        file.kind,
        file.jobId,
        file.epoch,
      ]),
    )
    .digest();
}
export async function purgeAudit(
  c: PoolConnection,
  p: RowDataPacket,
  action: string,
  transition: string,
  category = "SUCCESS",
) {
  await c.execute(
    `INSERT INTO audit_logs (family_id,operation_id,purge_intent_id,media_id,storage_object_id,
    actor_kind,actor_member_id,action,lifecycle_revision,transition_id,result_category)
    VALUES (?,?,?,?,?,'SYSTEM',NULL,?,?,?,?)`,
    [
      p.familyId,
      p.operationId,
      p.id,
      p.mediaId,
      p.storageId,
      action,
      p.revision,
      transition,
      category,
    ],
  );
}
export async function readPurgeIntent(
  c: Pick<PoolConnection, "execute">,
  id: string,
) {
  const [rows] = await c.execute<RowDataPacket[]>(
    `SELECT CAST(id AS CHAR) id, CAST(family_id AS CHAR) familyId,
    operation_id operationId, CAST(media_id AS CHAR) mediaId, CAST(storage_object_id AS CHAR) storageId,
    CAST(source_upload_id AS CHAR) sourceId, CAST(lifecycle_revision AS CHAR) revision,
    progress, execution_state executionState, CAST(original_bytes AS CHAR) originalBytes,
    CAST(derived_bytes AS CHAR) derivedBytes, CAST(released_bytes AS CHAR) releasedBytes,
    TIMESTAMPDIFF(MICROSECOND,CURRENT_TIMESTAMP(3),locked_until)/1000 remainingMs
    FROM purge_intents WHERE id=?`,
    [id],
  );
  return rows[0];
}
export async function lockPurgeExecution(
  c: PoolConnection,
  lease: PurgeNormalizationLease,
  familyId: string,
) {
  await c.execute("SELECT id FROM families WHERE id=? FOR UPDATE", [familyId]);
  const p = await readPurgeIntent(c, lease.id);
  if (!p || p.familyId !== familyId) throw new Error("PURGE_STALE");
  const [stores] = await c.execute<RowDataPacket[]>(
    `SELECT CAST(id AS CHAR) id, state, LOWER(HEX(sha256)) sha256Hex,
    CAST(byte_size AS CHAR) byteSize FROM storage_objects WHERE family_id=? AND id=? FOR UPDATE`,
    [familyId, p.storageId],
  );
  const [valid] = await c.execute<RowDataPacket[]>(
    `SELECT id FROM purge_intents WHERE id=? AND family_id=?
    AND execution_state='RUNNING' AND worker_id=? AND lease_epoch=? AND locked_until>CURRENT_TIMESTAMP(3) FOR UPDATE`,
    [lease.id, familyId, lease.workerId, lease.epoch.toString()],
  );
  if (!valid.length) throw new Error("PURGE_STALE");
  const fresh = (await readPurgeIntent(c, lease.id))!;
  if (fresh.progress === "REQUESTED") throw new Error("PURGE_NOT_DETACHED");
  if (
    !stores[0] ||
    stores[0].state !== "PURGING" ||
    stores[0].byteSize !== fresh.originalBytes
  )
    throw new Error("PURGE_INVARIANT");
  const [refs] = await c.execute<RowDataPacket[]>(
    `SELECT id FROM media_items WHERE family_id=? AND (id=? OR storage_object_id=?) FOR UPDATE`,
    [familyId, fresh.mediaId, fresh.storageId],
  );
  const [receipts] = await c.execute<RowDataPacket[]>(
    `SELECT CAST(id AS CHAR) id,state,CAST(retired_purge_id AS CHAR) retiredId,
    CAST(retired_storage_object_id AS CHAR) retiredStorageId FROM upload_sessions WHERE family_id=?
    AND (storage_object_id=? OR retired_storage_object_id=? OR id=?) FOR UPDATE`,
    [familyId, fresh.storageId, fresh.storageId, fresh.sourceId],
  );
  if (
    refs.length ||
    !receipts.some((r) => r.id === fresh.sourceId) ||
    receipts.some(
      (r) =>
        r.state !== "RETIRED" ||
        r.retiredId !== fresh.id ||
        r.retiredStorageId !== fresh.storageId,
    )
  )
    throw new Error("PURGE_REFERENCE_CONFLICT");
  for (const table of [
    "media_location_projections",
    "album_media",
    "user_favorites",
    "family_featured",
    "media_tags",
    "comments",
    "derived_assets",
    "background_jobs",
  ]) {
    const [rows] = await c.execute<RowDataPacket[]>(
      `SELECT COUNT(*) n FROM ${table} WHERE family_id=? AND media_id=?`,
      [familyId, fresh.mediaId],
    );
    if (Number(rows[0]!.n) !== 0) throw new Error("PURGE_INVARIANT");
  }
  const [audit] = await c.execute<RowDataPacket[]>(
    "SELECT id FROM audit_logs WHERE family_id=? AND purge_intent_id=? AND action='PURGE_STARTED'",
    [familyId, lease.id],
  );
  if (audit.length !== 1) throw new Error("PURGE_INVARIANT");
  const [files] = await c.execute<(RowDataPacket & PurgeFile)[]>(
    `SELECT CAST(id AS CHAR) id,CAST(family_id AS CHAR) familyId,
    CAST(purge_intent_id AS CHAR) intentId,file_kind fileKind,CAST(storage_object_id AS CHAR) storageId,
    CAST(media_id AS CHAR) mediaId,LOWER(HEX(content_sha256)) sha256Hex,CAST(byte_size AS CHAR) byteSize,
    root_marker_id markerId,CAST(root_device AS CHAR) device,CAST(generation AS CHAR) generation,recipe_id recipeId,
    derived_kind kind,CAST(producer_job_id AS CHAR) jobId,CAST(producer_epoch AS CHAR) epoch,stage,
    LOWER(HEX(quarantine_slot)) slotHex,CAST(quarantine_device AS CHAR) quarantineDevice,
    CAST(quarantine_inode AS CHAR) quarantineInode, identity_key identityKey
    FROM purge_files WHERE family_id=? AND purge_intent_id=? ORDER BY file_kind='ORIGINAL',id FOR UPDATE`,
    [familyId, lease.id],
  );
  const originals = files.filter((f) => f.fileKind === "ORIGINAL");
  if (
    originals.length !== 1 ||
    originals[0]!.storageId !== fresh.storageId ||
    originals[0]!.sha256Hex !== stores[0].sha256Hex ||
    originals[0]!.byteSize !== fresh.originalBytes ||
    files.some(
      (f) =>
        !purgeIdentity(f).equals(f.identityKey) ||
        (f.fileKind === "DERIVED" &&
          (f.mediaId !== fresh.mediaId || f.recipeId !== 1)) ||
        (f.slotHex !== null &&
          f.slotHex !== purgeSlot(f.intentId, f.id).toString("hex")),
    ) ||
    files
      .filter((f) => f.fileKind === "DERIVED")
      .reduce((s, f) => s + BigInt(f.byteSize), 0n) !==
      BigInt(fresh.derivedBytes)
  )
    throw new Error("PURGE_MANIFEST_INVARIANT");
  const [authority] = await c.execute<RowDataPacket[]>(
    `SELECT TIMESTAMPDIFF(MICROSECOND,CURRENT_TIMESTAMP(3),locked_until)/1000 remainingMs
     FROM purge_intents WHERE id=? AND execution_state='RUNNING' AND lease_epoch=? AND worker_id=?
       AND locked_until>CURRENT_TIMESTAMP(3) FOR UPDATE`,
    [lease.id, lease.epoch.toString(), lease.workerId],
  );
  if (!authority[0]) throw new Error("PURGE_STALE");
  fresh.remainingMs = authority[0].remainingMs;
  return { intent: fresh, storage: stores[0], files };
}
export async function detachPurge(
  c: PoolConnection,
  lease: PurgeNormalizationLease,
  familyId: string,
  expected: Awaited<ReturnType<typeof lockPurgeNormalization>>,
  root: { markerId: string; device: string },
) {
  const v = await lockPurgeNormalization(c, lease, familyId);
  if (
    JSON.stringify(v.assets) !== JSON.stringify(expected.assets) ||
    JSON.stringify(v.jobs) !== JSON.stringify(expected.jobs)
  )
    throw new Error("PURGE_ASSET_CHANGED");
  const [others] = await c.execute<RowDataPacket[]>(
    `SELECT id FROM media_items WHERE family_id=? AND storage_object_id=? AND id<>? FOR UPDATE`,
    [familyId, v.intent.storageId, v.intent.mediaId],
  );
  const [pending] = await c.execute<RowDataPacket[]>(
    `SELECT id FROM upload_sessions WHERE family_id=? AND state='FINALIZING' AND computed_sha256=UNHEX(?) AND declared_size=? FOR UPDATE`,
    [familyId, v.storage.sha256Hex, v.storage.byteSize],
  );
  if (others.length || pending.length)
    throw new Error("PURGE_REFERENCE_CONFLICT");
  const [old] = await c.execute<RowDataPacket[]>(
    "SELECT id FROM purge_files WHERE family_id=? AND purge_intent_id=? FOR UPDATE",
    [familyId, lease.id],
  );
  if (old.length) throw new Error("PURGE_MANIFEST_INVARIANT");
  const base = {
    familyId,
    intentId: lease.id,
    markerId: root.markerId,
    device: root.device,
  };
  const files: Omit<
    PurgeFile,
    "id" | "stage" | "slotHex" | "quarantineDevice" | "quarantineInode"
  >[] = [
    {
      ...base,
      fileKind: "ORIGINAL",
      storageId: v.intent.storageId,
      mediaId: null,
      sha256Hex: v.storage.sha256Hex,
      byteSize: v.storage.byteSize,
      generation: null,
      recipeId: null,
      kind: null,
      jobId: null,
      epoch: null,
    },
  ];
  for (const a of v.assets) {
    if (a.state !== "READY") {
      if (!a.cleanedAt) throw new Error("PURGE_UNCLEANED");
      continue;
    }
    if (a.cleanedAt || !a.sha256Hex || !a.byteSize)
      throw new Error("PURGE_MANIFEST_INVARIANT");
    files.push({
      ...base,
      fileKind: "DERIVED",
      storageId: null,
      mediaId: a.mediaId,
      sha256Hex: a.sha256Hex,
      byteSize: a.byteSize,
      generation: a.generation,
      recipeId: a.recipeId,
      kind: a.kind,
      jobId: a.jobId,
      epoch: a.epoch,
    });
  }
  for (const f of files)
    await c.execute(
      `INSERT INTO purge_files (family_id,purge_intent_id,file_kind,original_singleton_slot,identity_key,
    storage_object_id,media_id,content_sha256,byte_size,root_marker_id,root_device,generation,recipe_id,derived_kind,producer_job_id,producer_epoch)
    VALUES (?,?,?,?,?,?,?,UNHEX(?),?,?,?,?,?,?,?,?)`,
      [
        familyId,
        lease.id,
        f.fileKind,
        f.fileKind === "ORIGINAL" ? 1 : null,
        purgeIdentity(f),
        f.storageId,
        f.mediaId,
        f.sha256Hex,
        f.byteSize,
        f.markerId,
        f.device,
        f.generation,
        f.recipeId,
        f.kind,
        f.jobId,
        f.epoch,
      ],
    );
  for (const table of [
    "media_location_projections",
    "album_media",
    "user_favorites",
    "family_featured",
    "media_tags",
    "comments",
    "derived_assets",
    "background_jobs",
  ])
    await c.execute(`DELETE FROM ${table} WHERE family_id=? AND media_id=?`, [
      familyId,
      v.intent.mediaId,
    ]);
  await c.execute("DELETE FROM media_items WHERE family_id=? AND id=?", [
    familyId,
    v.intent.mediaId,
  ]);
  await c.execute(
    `UPDATE upload_sessions SET state='RETIRED',retired_storage_object_id=storage_object_id,storage_object_id=NULL,
    retired_purge_id=?,retired_at=CURRENT_TIMESTAMP(3),updated_at=CURRENT_TIMESTAMP(3) WHERE family_id=? AND storage_object_id=? AND state='COMPLETE'`,
    [lease.id, familyId, v.intent.storageId],
  );
  await c.execute(
    "UPDATE storage_objects SET state='PURGING',updated_at=CURRENT_TIMESTAMP(3) WHERE family_id=? AND id=? AND state='AVAILABLE'",
    [familyId, v.intent.storageId],
  );
  const bytes = files
    .filter((f) => f.fileKind === "DERIVED")
    .reduce((s, f) => s + BigInt(f.byteSize), 0n);
  await c.execute(
    "UPDATE purge_intents SET derived_bytes=?,progress='DETACHED',updated_at=CURRENT_TIMESTAMP(3) WHERE id=?",
    [bytes.toString(), lease.id],
  );
  await purgeAudit(
    c,
    { ...v.intent, familyId },
    "PURGE_STARTED",
    v.intent.operationId,
  );
  await lockPurgeExecution(c, lease, familyId);
}
export async function changePurgeFile(
  c: PoolConnection,
  lease: PurgeNormalizationLease,
  familyId: string,
  expected: PurgeFile,
  next: PurgeFile["stage"],
  fact?: { device: string; inode: string },
) {
  const v = await lockPurgeExecution(c, lease, familyId),
    f = v.files.find((f) => f.id === expected.id);
  if (!f || JSON.stringify(f) !== JSON.stringify(expected))
    throw new Error("PURGE_FILE_CHANGED");
  const allowed: Record<PurgeFile["stage"], PurgeFile["stage"][]> = {
    CATALOGUED: ["QUARANTINED", "ABSENT_DERIVED"],
    QUARANTINED: ["UNLINK_ARMED"],
    UNLINK_ARMED: ["REMOVED"],
    REMOVED: [],
    ABSENT_DERIVED: [],
  };
  if (
    v.intent.progress !== "DETACHED" ||
    !allowed[f.stage].includes(next) ||
    (next === "ABSENT_DERIVED" && f.fileKind !== "DERIVED")
  )
    throw new Error("PURGE_FILE_TRANSITION");
  if (
    f.fileKind === "ORIGINAL" &&
    v.files.some(
      (a) =>
        a.fileKind === "DERIVED" &&
        !["REMOVED", "ABSENT_DERIVED"].includes(a.stage),
    )
  )
    throw new Error("PURGE_DERIVED_FIRST");
  if (
    f.fileKind === "ORIGINAL" &&
    BigInt(v.intent.releasedBytes) < BigInt(v.intent.derivedBytes)
  )
    throw new Error("PURGE_DERIVED_UNRELEASED");
  if (next === "QUARANTINED") {
    if (!fact || fact.device !== f.device)
      throw new Error("PURGE_FILE_IDENTITY");
    await c.execute(
      "UPDATE purge_files SET stage=?,quarantine_slot=?,quarantine_device=?,quarantine_inode=?,updated_at=CURRENT_TIMESTAMP(3) WHERE id=?",
      [next, purgeSlot(lease.id, f.id), fact.device, fact.inode, f.id],
    );
  } else
    await c.execute(
      "UPDATE purge_files SET stage=?,updated_at=CURRENT_TIMESTAMP(3) WHERE id=?",
      [next, f.id],
    );
}
export async function settlePurge(
  c: PoolConnection,
  lease: PurgeNormalizationLease,
  familyId: string,
) {
  const v = await lockPurgeExecution(c, lease, familyId);
  const terminal = (f: PurgeFile) =>
    ["REMOVED", "ABSENT_DERIVED"].includes(f.stage);
  if (v.files.filter((f) => f.fileKind === "DERIVED").every(terminal)) {
    const all = v.files.every(terminal);
    const released =
      BigInt(v.intent.derivedBytes) +
      (all ? BigInt(v.intent.originalBytes) : 0n);
    if (BigInt(v.intent.releasedBytes) > released)
      throw new Error("PURGE_CAPACITY_INVARIANT");
    await c.execute(
      "UPDATE purge_intents SET released_bytes=?,progress=?,updated_at=CURRENT_TIMESTAMP(3) WHERE id=?",
      [
        released.toString(),
        all ? "FILES_REMOVED" : v.intent.progress,
        lease.id,
      ],
    );
  }
}
export async function completePurge(
  c: PoolConnection,
  lease: PurgeNormalizationLease,
  familyId: string,
) {
  const v = await lockPurgeExecution(c, lease, familyId);
  if (
    v.intent.progress !== "FILES_REMOVED" ||
    v.files.some((f) => !["REMOVED", "ABSENT_DERIVED"].includes(f.stage)) ||
    BigInt(v.intent.releasedBytes) !==
      BigInt(v.intent.derivedBytes) + BigInt(v.intent.originalBytes)
  )
    throw new Error("PURGE_INVARIANT");
  await c.execute("DELETE FROM storage_objects WHERE family_id=? AND id=?", [
    familyId,
    v.intent.storageId,
  ]);
  await c.execute(
    `UPDATE purge_intents SET progress='COMPLETED',execution_state='DONE',worker_id=NULL,locked_at=NULL,
    heartbeat_at=NULL,locked_until=NULL,completed_at=CURRENT_TIMESTAMP(3),updated_at=CURRENT_TIMESTAMP(3) WHERE id=?`,
    [lease.id],
  );
  await purgeAudit(c, v.intent, "PURGE_COMPLETED", v.intent.operationId);
}
