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

export type DerivedFilesystemObservation = {
  jobId: string;
  epoch: bigint;
  kind: "THUMBNAIL" | "PREVIEW";
  byteSize: bigint;
  device: string;
  inode: string;
};

export type CorrelatedDerivedTemp = {
  familyId: string;
  mediaId: string;
  generation: bigint;
  recipeId: number;
  kind: "THUMBNAIL" | "PREVIEW";
  producerJobId: string;
  epoch: bigint;
  reservedBytes: bigint;
  state: string;
  cleanedAt: null;
  observedBytes: bigint;
};

type ReservationIdentityRow = RowDataPacket & {
  id: string;
  familyId: string;
  mediaId: string;
  generation: string;
  recipeId: number;
  kind: string;
  state: string;
  reservedBytes: string;
  producerJobId: string;
  producerLeaseEpoch: string | null;
  cleanedAt: Date | null;
};

const UINT64_MAX = 18446744073709551615n;

function canonicalId(value: string) {
  if (!/^[1-9][0-9]{0,19}$/u.test(value)) return null;
  const parsed = BigInt(value);
  if (parsed <= 0n || parsed > UINT64_MAX || parsed.toString() !== value) {
    return null;
  }
  return parsed;
}

/**
 * Bind filesystem observations to authoritative reservation rows.
 * A pathname is only a lookup key. Capacity stays on reserved_bytes;
 * observed file size is not the charge. Any mismatch fails closed.
 */
export async function correlateDerivedFilesystemInventory(
  connection: PoolConnection,
  observations: readonly DerivedFilesystemObservation[] | undefined,
): Promise<{ complete: boolean; matches: CorrelatedDerivedTemp[] }> {
  if (!Array.isArray(observations)) return { complete: false, matches: [] };
  if (observations.length === 0) return { complete: true, matches: [] };
  const [rows] = await connection.query<ReservationIdentityRow[]>(
    `SELECT CAST(id AS CHAR) AS id,
       CAST(family_id AS CHAR) AS familyId,
       CAST(media_id AS CHAR) AS mediaId,
       CAST(generation AS CHAR) AS generation,
       recipe_id AS recipeId, kind, state,
       CAST(reserved_bytes AS CHAR) AS reservedBytes,
       CAST(producer_job_id AS CHAR) AS producerJobId,
       CAST(producer_lease_epoch AS CHAR) AS producerLeaseEpoch,
       cleaned_at AS cleanedAt
     FROM derived_assets ORDER BY id FOR UPDATE`,
  );
  const used = new Set<string>();
  const matches: CorrelatedDerivedTemp[] = [];
  for (const observation of observations) {
    if (
      typeof observation.epoch !== "bigint" ||
      typeof observation.byteSize !== "bigint" ||
      canonicalId(observation.jobId) === null ||
      observation.epoch <= 0n ||
      observation.epoch > UINT64_MAX ||
      (observation.kind !== "THUMBNAIL" && observation.kind !== "PREVIEW") ||
      observation.byteSize < 0n
    ) {
      return { complete: false, matches: [] };
    }
    const hits = rows.filter(
      (row) =>
        row.cleanedAt === null &&
        row.producerJobId === observation.jobId &&
        row.producerLeaseEpoch === observation.epoch.toString() &&
        row.kind === observation.kind,
    );
    const row = hits.length === 1 ? hits[0] : undefined;
    const familyId = row ? canonicalId(row.familyId) : null;
    const mediaId = row ? canonicalId(row.mediaId) : null;
    const generation = row ? canonicalId(row.generation) : null;
    const reservedBytes = row ? canonicalId(row.reservedBytes) : null;
    if (
      !row ||
      used.has(row.id) ||
      familyId === null ||
      mediaId === null ||
      generation === null ||
      reservedBytes === null ||
      !Number.isSafeInteger(row.recipeId) ||
      row.recipeId < 1 ||
      typeof row.state !== "string" ||
      row.state.length === 0
    ) {
      return { complete: false, matches: [] };
    }
    used.add(row.id);
    matches.push({
      familyId: row.familyId,
      mediaId: row.mediaId,
      generation,
      recipeId: row.recipeId,
      kind: observation.kind,
      producerJobId: row.producerJobId,
      epoch: observation.epoch,
      reservedBytes,
      state: row.state,
      cleanedAt: null,
      observedBytes: observation.byteSize,
    });
  }
  return { complete: true, matches };
}
