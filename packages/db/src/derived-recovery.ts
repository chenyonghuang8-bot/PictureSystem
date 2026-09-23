import { performance } from "node:perf_hooks";

import type {
  Pool,
  PoolConnection,
  ResultSetHeader,
  RowDataPacket,
} from "mysql2/promise";

import {
  readCapacityOutcome,
  runCapacityTransaction,
} from "./capacity-transaction.js";

export type DerivedRecoveryCapability =
  "READ_WRITE" | "READ_ONLY" | "UNAVAILABLE";

export type DerivedRecoveryFileClass =
  "ABSENT" | "REGULAR" | "SYMLINK" | "UNSAFE";

export type DerivedRecoveryTempFact = {
  jobId: string;
  epoch: bigint;
  kind: "THUMBNAIL" | "PREVIEW";
  byteSize: bigint;
  device: string;
  inode: string;
  mode: number;
  nlink: number;
  sha256Hex: string;
  fileClass: DerivedRecoveryFileClass;
};

export type DerivedRecoveryFinalFact = {
  familyId: string;
  mediaId: string;
  generation: bigint;
  recipeId: number;
  kind: "THUMBNAIL" | "PREVIEW";
  byteSize: bigint;
  device: string;
  inode: string;
  mode: number;
  nlink: number;
  sha256Hex: string;
  fileClass: DerivedRecoveryFileClass;
};

export type DerivedRecoveryRow = {
  id: string;
  familyId: string;
  mediaId: string;
  generation: bigint;
  recipeId: number;
  kind: "THUMBNAIL" | "PREVIEW";
  state: string;
  reservedBytes: bigint;
  byteSize: bigint | null;
  sha256Hex: string | null;
  producerJobId: string;
  producerLeaseEpoch: bigint | null;
  cleanedAt: Date | null;
};

export type DerivedRecoveryDecision =
  | "INVENTORY_INCOMPLETE"
  | "UNAVAILABLE"
  | "COMMIT_UNKNOWN"
  | "TEMP_ONLY_RETAIN"
  | "TEMP_ONLY_RELEASED"
  | "ACCOUNTING_RETAINED"
  | "SEALED_CANDIDATE"
  | "RECOVERY_REQUIRED"
  | "PUBLISH_BEFORE_DB"
  | "FINAL_CONFLICT"
  | "UNBOUND_FINAL"
  | "SYMLINK"
  | "UNKNOWN_RESIDUE"
  | "READ_ONLY_REPORT";

const CANONICAL = /^[1-9][0-9]{0,19}$/u;

function canonical(value: string) {
  return CANONICAL.test(value);
}

function sameIdentity(
  row: DerivedRecoveryRow,
  final: DerivedRecoveryFinalFact | null,
  temp: DerivedRecoveryTempFact | null,
) {
  if (
    !canonical(row.familyId) ||
    !canonical(row.mediaId) ||
    !canonical(row.producerJobId) ||
    row.generation < 1n ||
    row.recipeId !== 1 ||
    (row.kind !== "THUMBNAIL" && row.kind !== "PREVIEW") ||
    row.cleanedAt !== null
  ) {
    return false;
  }
  if (
    temp !== null &&
    (temp.jobId !== row.producerJobId ||
      temp.epoch !== row.producerLeaseEpoch ||
      temp.kind !== row.kind ||
      temp.nlink !== 1 ||
      !canonical(temp.device) ||
      !canonical(temp.inode) ||
      temp.sha256Hex.length !== 64)
  ) {
    return false;
  }
  if (
    final !== null &&
    final.fileClass !== "ABSENT" &&
    (final.familyId !== row.familyId ||
      final.mediaId !== row.mediaId ||
      final.generation !== row.generation ||
      final.recipeId !== row.recipeId ||
      final.kind !== row.kind)
  ) {
    return false;
  }
  return true;
}

/**
 * One identity, already correlated by job/epoch/kind or by the final key.
 * This does not delete, rename, or write READY.
 */
export function classifyDerivedRecoveryCase(input: {
  capability: DerivedRecoveryCapability;
  inventoryComplete: boolean;
  temp: DerivedRecoveryTempFact | null;
  final: DerivedRecoveryFinalFact | null;
  row: DerivedRecoveryRow | null | "UNKNOWN";
  leaseCurrent: boolean | "UNKNOWN";
}): DerivedRecoveryDecision {
  if (input.capability === "UNAVAILABLE") return "UNAVAILABLE";
  if (!input.inventoryComplete) return "INVENTORY_INCOMPLETE";
  if (input.row === "UNKNOWN" || input.leaseCurrent === "UNKNOWN") {
    return "COMMIT_UNKNOWN";
  }
  const temp = input.temp;
  const final = input.final;
  if (temp?.fileClass === "SYMLINK" || final?.fileClass === "SYMLINK") {
    return "SYMLINK";
  }
  if (temp !== null && temp.fileClass !== "REGULAR") return "UNKNOWN_RESIDUE";
  if (final !== null && final.fileClass === "UNSAFE") return "FINAL_CONFLICT";
  if (input.row === null) {
    if (final?.fileClass === "REGULAR") return "UNBOUND_FINAL";
    return "UNKNOWN_RESIDUE";
  }
  if (!sameIdentity(input.row, final, temp)) return "RECOVERY_REQUIRED";
  if (
    input.row.sha256Hex !== null &&
    final?.fileClass === "REGULAR" &&
    final.sha256Hex !== input.row.sha256Hex
  ) {
    return "FINAL_CONFLICT";
  }
  if (
    temp?.fileClass === "REGULAR" &&
    final?.fileClass === "REGULAR" &&
    temp.sha256Hex !== final.sha256Hex
  ) {
    return "FINAL_CONFLICT";
  }
  if (final?.fileClass === "REGULAR") {
    if (input.row.state !== "RESERVED" && input.row.state !== "PUBLISHING") {
      return "RECOVERY_REQUIRED";
    }
    return "PUBLISH_BEFORE_DB";
  }
  if (temp === null) return "ACCOUNTING_RETAINED";
  if (temp.mode === 0o400) return "SEALED_CANDIDATE";
  if (temp.mode !== 0o600 || temp.fileClass !== "REGULAR") {
    return "RECOVERY_REQUIRED";
  }
  if (input.leaseCurrent) return "TEMP_ONLY_RETAIN";
  if (input.capability !== "READ_WRITE") return "READ_ONLY_REPORT";
  if (input.row.state !== "RESERVED" || input.row.sha256Hex !== null) {
    return "RECOVERY_REQUIRED";
  }
  return "TEMP_ONLY_RETAIN";
}

export type DerivedRecoveryAction = {
  code: DerivedRecoveryDecision;
  familyId?: string;
  mediaId?: string;
  generation?: bigint;
  kind?: "THUMBNAIL" | "PREVIEW";
};

type AssetLookup = RowDataPacket & {
  id: string;
  familyId: string;
  mediaId: string;
  generation: string;
  recipeId: number;
  kind: "THUMBNAIL" | "PREVIEW";
  state: string;
  reservedBytes: string;
  byteSize: string | null;
  sha256Hex: string | null;
  producerJobId: string;
  producerLeaseEpoch: string | null;
  cleanedAt: Date | null;
};

const ASSET_SQL = `SELECT CAST(id AS CHAR) AS id,
  CAST(family_id AS CHAR) AS familyId,
  CAST(media_id AS CHAR) AS mediaId,
  CAST(generation AS CHAR) AS generation,
  recipe_id AS recipeId, kind, state,
  CAST(reserved_bytes AS CHAR) AS reservedBytes,
  CAST(byte_size AS CHAR) AS byteSize,
  LOWER(HEX(sha256)) AS sha256Hex,
  CAST(producer_job_id AS CHAR) AS producerJobId,
  CAST(producer_lease_epoch AS CHAR) AS producerLeaseEpoch,
  cleaned_at AS cleanedAt
FROM derived_assets`;

function toRow(row: AssetLookup): DerivedRecoveryRow | "UNKNOWN" {
  if (
    !canonical(row.id) ||
    !canonical(row.familyId) ||
    !canonical(row.mediaId) ||
    !canonical(row.generation) ||
    !canonical(row.producerJobId) ||
    (row.kind !== "THUMBNAIL" && row.kind !== "PREVIEW") ||
    !canonical(row.reservedBytes)
  ) {
    return "UNKNOWN";
  }
  return {
    id: row.id,
    familyId: row.familyId,
    mediaId: row.mediaId,
    generation: BigInt(row.generation),
    recipeId: row.recipeId,
    kind: row.kind,
    state: row.state,
    reservedBytes: BigInt(row.reservedBytes),
    byteSize: row.byteSize === null ? null : BigInt(row.byteSize),
    sha256Hex: row.sha256Hex,
    producerJobId: row.producerJobId,
    producerLeaseEpoch:
      row.producerLeaseEpoch === null ? null : BigInt(row.producerLeaseEpoch),
    cleanedAt: row.cleanedAt,
  };
}

async function readOne(
  connection: PoolConnection,
  sql: string,
  params: readonly string[],
) {
  const [rows] = await connection.query<AssetLookup[]>(sql, params as string[]);
  if (rows.length > 1) return "UNKNOWN" as const;
  return rows[0] ? toRow(rows[0]) : null;
}

async function leaseIsCurrent(
  connection: PoolConnection,
  row: DerivedRecoveryRow,
) {
  const [jobs] = await connection.query<RowDataPacket[]>(
    `SELECT state, CAST(generation AS CHAR) AS generation,
       recipe_id AS recipeId, CAST(lease_epoch AS CHAR) AS leaseEpoch,
       locked_until AS lockedUntil
     FROM background_jobs
     WHERE id=? AND family_id=? AND media_id=? AND job_type='IMAGE_DERIVATIVES'`,
    [row.producerJobId, row.familyId, row.mediaId],
  );
  const job = jobs[0];
  if (!job || jobs.length !== 1) return "UNKNOWN" as const;
  const [nowRows] = await connection.query<RowDataPacket[]>(
    "SELECT UTC_TIMESTAMP(3) AS now",
  );
  const now = nowRows[0]?.now;
  return (
    job.state === "RUNNING" &&
    BigInt(String(job.generation)) === row.generation &&
    Number(job.recipeId) === row.recipeId &&
    row.producerLeaseEpoch !== null &&
    String(job.leaseEpoch) === row.producerLeaseEpoch.toString() &&
    now instanceof Date &&
    job.lockedUntil instanceof Date &&
    job.lockedUntil.getTime() > now.getTime()
  );
}

/**
 * Filesystem cleanup is the caller's callback and stays outside the SQL
 * transaction. cleaned_at is set only after that callback resolves.
 * READY, job completion, and reservation release without cleanup are refused.
 */
export async function reconcileDerivedPublishRecovery(input: {
  pool: Pool;
  capability: DerivedRecoveryCapability;
  inventoryComplete: boolean;
  temps: readonly DerivedRecoveryTempFact[];
  finals: readonly DerivedRecoveryFinalFact[];
  cleanupExact?: (
    temp: DerivedRecoveryTempFact,
    row: DerivedRecoveryRow,
  ) => Promise<void>;
  commitForTest?: (connection: PoolConnection) => Promise<void>;
}): Promise<DerivedRecoveryAction[]> {
  if (input.capability === "UNAVAILABLE" || !input.inventoryComplete) {
    return [
      {
        code:
          input.capability === "UNAVAILABLE"
            ? "UNAVAILABLE"
            : "INVENTORY_INCOMPLETE",
      },
    ];
  }
  const actions: DerivedRecoveryAction[] = [];
  const consumedFinals = new Set<DerivedRecoveryFinalFact>();
  for (const temp of input.temps) {
    const connection = await input.pool.getConnection();
    let row: DerivedRecoveryRow | null | "UNKNOWN";
    let leaseCurrent: boolean | "UNKNOWN";
    try {
      row = await readOne(
        connection,
        `${ASSET_SQL}
         WHERE producer_job_id=? AND producer_lease_epoch=? AND kind=?
           AND cleaned_at IS NULL`,
        [temp.jobId, temp.epoch.toString(), temp.kind],
      );
      if (row !== null && row !== "UNKNOWN") {
        const lease = await leaseIsCurrent(connection, row);
        leaseCurrent = lease;
      } else {
        leaseCurrent = false;
      }
    } catch {
      row = "UNKNOWN";
      leaseCurrent = "UNKNOWN";
    } finally {
      connection.release();
    }
    const final =
      row !== null && row !== "UNKNOWN"
        ? (input.finals.find(
            (item) =>
              item.familyId === row.familyId &&
              item.mediaId === row.mediaId &&
              item.generation === row.generation &&
              item.recipeId === row.recipeId &&
              item.kind === row.kind,
          ) ?? null)
        : null;
    if (final) consumedFinals.add(final);
    const preliminary = classifyDerivedRecoveryCase({
      capability: input.capability,
      inventoryComplete: true,
      temp,
      final,
      row,
      leaseCurrent,
    });
    const asset = row !== null && row !== "UNKNOWN" ? row : null;
    const cleanupCandidate =
      preliminary === "TEMP_ONLY_RETAIN" &&
      input.capability === "READ_WRITE" &&
      leaseCurrent === false &&
      asset !== null &&
      temp.mode === 0o600 &&
      final === null;
    if (
      !cleanupCandidate ||
      asset === null ||
      input.cleanupExact === undefined
    ) {
      actions.push({
        code: preliminary,
        ...(row !== null && row !== "UNKNOWN"
          ? {
              familyId: row.familyId,
              mediaId: row.mediaId,
              generation: row.generation,
              kind: row.kind,
            }
          : {}),
      });
      continue;
    }
    try {
      await input.cleanupExact(temp, asset);
    } catch {
      actions.push({
        code: "RECOVERY_REQUIRED",
        familyId: asset.familyId,
        mediaId: asset.mediaId,
        generation: asset.generation,
        kind: asset.kind,
      });
      continue;
    }
    const deadline = performance.now() + 2_000;
    const released = await runCapacityTransaction(
      input.pool,
      deadline,
      async (transaction) => {
        const [result] = await transaction.query<ResultSetHeader>(
          `UPDATE derived_assets
           SET cleaned_at = UTC_TIMESTAMP(3)
           WHERE id=? AND family_id=? AND media_id=? AND generation=?
             AND recipe_id=1 AND kind=? AND state='RESERVED'
             AND cleaned_at IS NULL AND producer_job_id=?
             AND producer_lease_epoch=? AND byte_size IS NULL
             AND sha256 IS NULL`,
          [
            asset.id,
            asset.familyId,
            asset.mediaId,
            asset.generation.toString(),
            asset.kind,
            asset.producerJobId,
            asset.producerLeaseEpoch?.toString() ?? "",
          ],
        );
        if (result.affectedRows !== 1) {
          throw new Error("DERIVED_RECOVERY_ACCOUNTING");
        }
      },
      input.commitForTest === undefined
        ? {}
        : { commitForTest: input.commitForTest },
    );
    if (released.transaction === "COMMITTED") {
      actions.push({
        code: "TEMP_ONLY_RELEASED",
        familyId: asset.familyId,
        mediaId: asset.mediaId,
        generation: asset.generation,
        kind: asset.kind,
      });
      continue;
    }
    if (released.transaction !== "UNKNOWN") {
      actions.push({
        code: "ACCOUNTING_RETAINED",
        familyId: asset.familyId,
        mediaId: asset.mediaId,
        generation: asset.generation,
        kind: asset.kind,
      });
      continue;
    }
    const readback = await readCapacityOutcome(
      input.pool,
      deadline,
      (transaction) =>
        readOne(transaction, `${ASSET_SQL} WHERE id=?`, [asset.id]),
    );
    const committed =
      readback !== null &&
      readback !== "UNKNOWN" &&
      readback.cleanedAt !== null;
    actions.push({
      code: committed
        ? "TEMP_ONLY_RELEASED"
        : readback === null
          ? "COMMIT_UNKNOWN"
          : "ACCOUNTING_RETAINED",
      familyId: asset.familyId,
      mediaId: asset.mediaId,
      generation: asset.generation,
      kind: asset.kind,
    });
  }
  for (const final of input.finals) {
    if (consumedFinals.has(final)) continue;
    const connection = await input.pool.getConnection();
    let row: DerivedRecoveryRow | null | "UNKNOWN";
    try {
      row = await readOne(
        connection,
        `${ASSET_SQL}
         WHERE family_id=? AND media_id=? AND generation=?
           AND recipe_id=? AND kind=?`,
        [
          final.familyId,
          final.mediaId,
          final.generation.toString(),
          String(final.recipeId),
          final.kind,
        ],
      );
    } catch {
      row = "UNKNOWN";
    } finally {
      connection.release();
    }
    actions.push({
      code: classifyDerivedRecoveryCase({
        capability: input.capability,
        inventoryComplete: true,
        temp: null,
        final,
        row,
        leaseCurrent: false,
      }),
      familyId: final.familyId,
      mediaId: final.mediaId,
      generation: final.generation,
      kind: final.kind,
    });
  }
  return actions;
}
