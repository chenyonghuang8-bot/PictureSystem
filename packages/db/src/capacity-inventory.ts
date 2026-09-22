import type { PoolConnection, RowDataPacket } from "mysql2/promise";

// Active upload declared bytes are partitioned into committed staging and
// future write reservation. Terminal staging remains charged until cleanup.
export const RESERVED_FUTURE_SQL = `CASE WHEN state IN ('CREATED','UPLOADING')
  THEN declared_size - committed_offset ELSE 0 END`;
export const RETAINED_STAGING_SQL = `CASE
  WHEN state IN ('CREATED','UPLOADING') THEN committed_offset
  WHEN state IN ('FINALIZING','COMPLETE','FAILED','ABORTED','EXPIRED')
    AND staging_cleaned_at IS NULL THEN declared_size
  ELSE 0 END`;

export async function readUploadCapacityInventory(connection: PoolConnection) {
  const [rows] = await connection.query<RowDataPacket[]>(
    `SELECT
       CAST(COALESCE(SUM(${RESERVED_FUTURE_SQL}),0) AS CHAR) AS reservedFutureBytes,
       CAST(COALESCE(SUM(${RETAINED_STAGING_SQL}),0) AS CHAR) AS retainedStagingBytes,
       CAST((SELECT COALESCE(SUM(byte_size),0) FROM storage_objects) AS CHAR) AS storedBytes
     FROM upload_sessions`,
  );
  const reservedFutureBytes = BigInt(
    String(rows[0]?.reservedFutureBytes ?? "0"),
  );
  const retainedStagingBytes = BigInt(
    String(rows[0]?.retainedStagingBytes ?? "0"),
  );
  return {
    reservedFutureBytes,
    retainedStagingBytes,
    outstanding: reservedFutureBytes + retainedStagingBytes,
    stored: BigInt(String(rows[0]?.storedBytes ?? "0")),
  };
}

type AssetInventoryRow = RowDataPacket & {
  familyId: string;
  state: string;
  reservedBytes: string;
  byteSize: string | null;
  cleanedAt: Date | null;
};

export async function readDerivedCapacityInventory(connection: PoolConnection) {
  const [assets] = await connection.query<AssetInventoryRow[]>(
    `SELECT CAST(family_id AS CHAR) AS familyId, state,
      CAST(reserved_bytes AS CHAR) AS reservedBytes,
      CAST(byte_size AS CHAR) AS byteSize, cleaned_at AS cleanedAt
     FROM derived_assets ORDER BY id FOR UPDATE`,
  );
  const familyUsage = new Map<string, bigint>();
  let globalUsage = 0n;
  let unsettled = 0n;
  for (const asset of assets) {
    if (asset.cleanedAt !== null) continue;
    const charge =
      asset.state === "READY" && asset.byteSize !== null
        ? BigInt(asset.byteSize)
        : BigInt(asset.reservedBytes);
    globalUsage += charge;
    familyUsage.set(
      asset.familyId,
      (familyUsage.get(asset.familyId) ?? 0n) + charge,
    );
    if (asset.state !== "READY") unsettled += BigInt(asset.reservedBytes);
  }
  return { globalUsage, familyUsage, unsettled };
}
