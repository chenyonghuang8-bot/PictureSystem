import type {
  PoolConnection,
  RowDataPacket,
  ResultSetHeader,
} from "mysql2/promise";
export type {
  Pool as PurgeNormalizationPool,
  RowDataPacket as PurgeNormalizationRow,
} from "mysql2/promise";
export type { PoolConnection as PurgeNormalizationConnection } from "mysql2/promise";

// Internal worker repository. Each read occurs in a checked short transaction
// after writer/L-X/R-X/capacity admission; no background lease expiry rule.
export type PurgeNormalizationLease = {
  id: string;
  epoch: bigint;
  workerId: Buffer;
};
export async function lockPurgeNormalization(
  connection: PoolConnection,
  lease: PurgeNormalizationLease,
  familyId: string,
) {
  await connection.execute("SELECT id FROM families WHERE id=? FOR UPDATE", [
    familyId,
  ]);
  const [identities] = await connection.execute<RowDataPacket[]>(
    `SELECT CAST(storage_object_id AS CHAR) storageId, CAST(media_id AS CHAR) mediaId
     FROM purge_intents WHERE id=? AND family_id=?`,
    [lease.id, familyId],
  );
  const identity = identities[0];
  if (!identity) throw new Error("PURGE_STALE");
  const [storages] = await connection.execute<RowDataPacket[]>(
    `SELECT CAST(id AS CHAR) id, state, LOWER(HEX(sha256)) sha256Hex,
      CAST(byte_size AS CHAR) byteSize FROM storage_objects WHERE family_id=? AND id=? FOR UPDATE`,
    [familyId, identity.storageId],
  );
  const [media] = await connection.execute<RowDataPacket[]>(
    `SELECT CAST(id AS CHAR) id, CAST(storage_object_id AS CHAR) storageId,
      CAST(source_upload_id AS CHAR) sourceId, CAST(lifecycle_revision AS CHAR) revision,
      CAST(purge_intent_id AS CHAR) intentId, trashed_at trashedAt
     FROM media_items WHERE family_id=? AND id=? FOR UPDATE`,
    [familyId, identity.mediaId],
  );
  const [intents] = await connection.execute<RowDataPacket[]>(
    `SELECT CAST(id AS CHAR) id, operation_id operationId, CAST(media_id AS CHAR) mediaId,
      CAST(storage_object_id AS CHAR) storageId, CAST(source_upload_id AS CHAR) sourceId,
      CAST(lifecycle_revision AS CHAR) revision, CAST(original_bytes AS CHAR) originalBytes,
      TIMESTAMPDIFF(MICROSECOND,CURRENT_TIMESTAMP(3),locked_until) / 1000 remainingMs
     FROM purge_intents WHERE id=? AND family_id=? AND progress='REQUESTED'
      AND execution_state='RUNNING' AND lease_epoch=? AND worker_id=?
      AND locked_until>CURRENT_TIMESTAMP(3) FOR UPDATE`,
    [lease.id, familyId, lease.epoch.toString(), lease.workerId],
  );
  const intent = intents[0],
    item = media[0],
    storage = storages[0];
  if (
    !intent ||
    !item ||
    !storage ||
    !item.trashedAt ||
    item.intentId !== intent.id ||
    item.revision !== intent.revision ||
    item.storageId !== intent.storageId ||
    item.sourceId !== intent.sourceId ||
    storage.state !== "AVAILABLE" ||
    storage.byteSize !== intent.originalBytes
  )
    throw new Error("PURGE_STALE");
  const [jobs] = await connection.execute<RowDataPacket[]>(
    `SELECT CAST(id AS CHAR) id, CAST(generation AS CHAR) generation, recipe_id recipeId,
      job_type jobType, CAST(lease_epoch AS CHAR) epoch FROM background_jobs
     WHERE family_id=? AND media_id=? ORDER BY id FOR UPDATE`,
    [familyId, item.id],
  );
  const [assets] = await connection.execute<RowDataPacket[]>(
    `SELECT CAST(id AS CHAR) id, CAST(family_id AS CHAR) familyId, CAST(media_id AS CHAR) mediaId,
      CAST(generation AS CHAR) generation, recipe_id recipeId, kind, state,
      CAST(reserved_bytes AS CHAR) reservedBytes, CAST(byte_size AS CHAR) byteSize,
      LOWER(HEX(sha256)) sha256Hex, CAST(producer_job_id AS CHAR) jobId,
      CAST(producer_lease_epoch AS CHAR) epoch, cleaned_at cleanedAt,
      width, height, output_mime outputMime, failure_code failureCode, published_at publishedAt
     FROM derived_assets WHERE family_id=? AND media_id=? ORDER BY id FOR UPDATE`,
    [familyId, item.id],
  );
  for (const asset of assets) {
    const job = jobs.find((candidate) => candidate.id === asset.jobId);
    if (
      !job ||
      job.generation !== asset.generation ||
      job.recipeId !== asset.recipeId ||
      job.jobType !== "IMAGE_DERIVATIVES" ||
      asset.recipeId !== 1 ||
      !asset.epoch ||
      BigInt(asset.epoch) < 1n ||
      BigInt(asset.epoch) > BigInt(job.epoch) ||
      !["THUMBNAIL", "PREVIEW"].includes(asset.kind)
    )
      throw new Error("PURGE_ASSET_IDENTITY");
  }
  const [authority] = await connection.execute<RowDataPacket[]>(
    `SELECT TIMESTAMPDIFF(MICROSECOND,CURRENT_TIMESTAMP(3),locked_until)/1000 remainingMs
     FROM purge_intents WHERE id=? AND family_id=? AND progress='REQUESTED' AND execution_state='RUNNING'
       AND lease_epoch=? AND worker_id=? AND locked_until>CURRENT_TIMESTAMP(3) FOR UPDATE`,
    [lease.id, familyId, lease.epoch.toString(), lease.workerId],
  );
  if (!authority[0]) throw new Error("PURGE_STALE");
  intent.remainingMs = authority[0].remainingMs;
  return { intent, storage, assets, jobs };
}

export async function markPurgeDerivedCleaned(
  connection: PoolConnection,
  lease: PurgeNormalizationLease,
  familyId: string,
  expected: RowDataPacket,
) {
  const view = await lockPurgeNormalization(connection, lease, familyId);
  const current = view.assets.find((asset) => asset.id === expected.id);
  const fingerprint = (asset: RowDataPacket) => JSON.stringify(asset);
  if (!current || fingerprint(current) !== fingerprint(expected))
    throw new Error("PURGE_ASSET_CHANGED");
  if (current.state === "READY")
    throw new Error("PURGE_READY_CLEANUP_FORBIDDEN");
  if (current.cleanedAt) return;
  const [changed] = await connection.execute<ResultSetHeader>(
    `UPDATE derived_assets SET cleaned_at=CURRENT_TIMESTAMP(3)
     WHERE id=? AND family_id=? AND state IN ('RESERVED','PUBLISHING','FAILED','MISSING')
      AND cleaned_at IS NULL`,
    [current.id, familyId],
  );
  if (changed.affectedRows !== 1) throw new Error("PURGE_STALE");
}
