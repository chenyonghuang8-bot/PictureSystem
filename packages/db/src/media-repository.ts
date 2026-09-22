import type {
  Pool,
  PoolConnection,
  ResultSetHeader,
  RowDataPacket,
} from "mysql2/promise";
import type {
  Phase4MediaType,
  Phase4ProcessingState,
} from "@family-album/contracts";

import { runCheckedTransaction } from "./connection.js";

export type CanonicalMediaRecord = {
  id: string;
  familyId: string;
  storageObjectId: string;
  sourceUploadId: string;
  uploadedAt: Date;
  mediaType: Phase4MediaType;
  processingState: Phase4ProcessingState;
  generation: bigint;
  recipeId: number;
  timelineKey: Date;
  timelineBasis: "CAPTURE_LOCAL" | "UPLOAD_UTC";
  createdAt: Date;
  updatedAt: Date;
};

export type CanonicalMediaResult = {
  media: CanonicalMediaRecord;
  created: boolean;
};

export class MediaRepositoryError extends Error {
  constructor(
    readonly reason:
      | "NOT_FOUND"
      | "RECEIPT_NOT_COMPLETE"
      | "STORAGE_UNAVAILABLE"
      | "RECEIPT_STORAGE_MISMATCH"
      | "CONFLICT",
  ) {
    super(reason);
    this.name = "MediaRepositoryError";
  }
}

type UploadReceiptRow = RowDataPacket & {
  id: string;
  familyId: string;
  state: string;
  declaredSize: string;
  committedOffset: string;
  computedSha256: Buffer | null;
  storageObjectId: string | null;
  completedAt: Date | null;
};

type StorageObjectRow = RowDataPacket & {
  id: string;
  familyId: string;
  sha256: Buffer;
  byteSize: string;
  state: "AVAILABLE" | "MISSING" | "CORRUPT";
};

type MediaRow = RowDataPacket & {
  id: string;
  familyId: string;
  storageObjectId: string;
  sourceUploadId: string;
  uploadedAt: Date;
  mediaType: Phase4MediaType;
  processingState: Phase4ProcessingState;
  generation: string;
  recipeId: number;
  timelineKey: Date;
  timelineBasis: "CAPTURE_LOCAL" | "UPLOAD_UTC";
  createdAt: Date;
  updatedAt: Date;
};

const MEDIA_SELECT = `SELECT CAST(id AS CHAR) AS id,
  CAST(family_id AS CHAR) AS familyId,
  CAST(storage_object_id AS CHAR) AS storageObjectId,
  CAST(source_upload_id AS CHAR) AS sourceUploadId,
  uploaded_at AS uploadedAt, media_type AS mediaType,
  processing_state AS processingState, CAST(generation AS CHAR) AS generation,
  recipe_id AS recipeId, timeline_key AS timelineKey,
  timeline_basis AS timelineBasis, created_at AS createdAt,
  updated_at AS updatedAt
FROM media_items WHERE family_id=? AND storage_object_id=?`;

export class MySqlMediaRepository {
  constructor(private readonly pool: Pool) {}

  async createOrGetCanonicalMedia(input: {
    familyId: string;
    uploadId: string;
  }): Promise<CanonicalMediaResult> {
    assertId(input.familyId);
    assertId(input.uploadId);

    return runCheckedTransaction(this.pool, async (connection) => {
      await lockFamily(connection, input.familyId);
      const receipt = await lockReceipt(connection, input);
      assertCompletedReceipt(receipt);
      const storage = await lockStorageObject(
        connection,
        receipt.storageObjectId!,
      );
      assertReceiptStorage(input.familyId, receipt, storage);

      const existing = await findCanonicalMedia(
        connection,
        input.familyId,
        storage.id,
        false,
      );
      if (existing) return { media: existing, created: false };

      try {
        await connection.execute<ResultSetHeader>(
          `INSERT INTO media_items
            (family_id, storage_object_id, source_upload_id, uploaded_at,
             timeline_key)
           VALUES (?,?,?,?,?)`,
          [
            input.familyId,
            storage.id,
            receipt.id,
            receipt.completedAt,
            receipt.completedAt,
          ],
        );
      } catch (error) {
        if (!isCanonicalMediaIdentityDuplicate(error)) throw error;
        const winner = await findCanonicalMedia(
          connection,
          input.familyId,
          storage.id,
          true,
        );
        if (!winner) throw new MediaRepositoryError("CONFLICT");
        return { media: winner, created: false };
      }

      const created = await findCanonicalMedia(
        connection,
        input.familyId,
        storage.id,
        true,
      );
      if (!created || created.sourceUploadId !== receipt.id) {
        throw new MediaRepositoryError("CONFLICT");
      }
      return { media: created, created: true };
    });
  }
}

/** @internal Exported only so duplicate classification remains directly testable. */
export function isCanonicalMediaIdentityDuplicate(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const candidate = error as {
    code?: string;
    errno?: number;
    message?: string;
    sqlMessage?: string;
  };
  if (
    candidate.code !== "ER_DUP_ENTRY" ||
    (candidate.errno !== undefined && candidate.errno !== 1062)
  ) {
    return false;
  }
  const detail = `${candidate.sqlMessage ?? ""}\n${candidate.message ?? ""}`;
  return detail.includes("uq_media_items_family_storage_object");
}

async function lockFamily(connection: PoolConnection, familyId: string) {
  const [rows] = await connection.query<RowDataPacket[]>(
    "SELECT CAST(id AS CHAR) AS id FROM families WHERE id=? FOR SHARE",
    [familyId],
  );
  if (!rows[0]) throw new MediaRepositoryError("NOT_FOUND");
}

async function lockReceipt(
  connection: PoolConnection,
  input: { familyId: string; uploadId: string },
) {
  const [rows] = await connection.query<UploadReceiptRow[]>(
    `SELECT CAST(id AS CHAR) AS id, CAST(family_id AS CHAR) AS familyId,
      state, CAST(declared_size AS CHAR) AS declaredSize,
      CAST(committed_offset AS CHAR) AS committedOffset,
      computed_sha256 AS computedSha256,
      CAST(storage_object_id AS CHAR) AS storageObjectId,
      completed_at AS completedAt
     FROM upload_sessions
     WHERE id=? AND family_id=? FOR SHARE`,
    [input.uploadId, input.familyId],
  );
  const receipt = rows[0];
  if (!receipt) throw new MediaRepositoryError("NOT_FOUND");
  return receipt;
}

function assertCompletedReceipt(receipt: UploadReceiptRow) {
  if (
    receipt.state !== "COMPLETE" ||
    receipt.storageObjectId === null ||
    receipt.completedAt === null ||
    receipt.computedSha256 === null ||
    receipt.committedOffset !== receipt.declaredSize
  ) {
    throw new MediaRepositoryError("RECEIPT_NOT_COMPLETE");
  }
}

async function lockStorageObject(
  connection: PoolConnection,
  storageObjectId: string,
) {
  const [rows] = await connection.query<StorageObjectRow[]>(
    `SELECT CAST(id AS CHAR) AS id, CAST(family_id AS CHAR) AS familyId,
      sha256, CAST(byte_size AS CHAR) AS byteSize, state
     FROM storage_objects WHERE id=? FOR SHARE`,
    [storageObjectId],
  );
  const storage = rows[0];
  if (!storage) throw new MediaRepositoryError("NOT_FOUND");
  return storage;
}

function assertReceiptStorage(
  familyId: string,
  receipt: UploadReceiptRow,
  storage: StorageObjectRow,
) {
  if (storage.familyId !== familyId || receipt.storageObjectId !== storage.id) {
    throw new MediaRepositoryError("NOT_FOUND");
  }
  if (
    receipt.computedSha256 === null ||
    !receipt.computedSha256.equals(storage.sha256) ||
    receipt.declaredSize !== storage.byteSize
  ) {
    throw new MediaRepositoryError("RECEIPT_STORAGE_MISMATCH");
  }
  if (storage.state !== "AVAILABLE") {
    throw new MediaRepositoryError("STORAGE_UNAVAILABLE");
  }
}

async function findCanonicalMedia(
  connection: PoolConnection,
  familyId: string,
  storageObjectId: string,
  locking: boolean,
) {
  const [rows] = await connection.query<MediaRow[]>(
    `${MEDIA_SELECT}${locking ? " FOR SHARE" : ""}`,
    [familyId, storageObjectId],
  );
  return rows[0] ? mapMedia(rows[0]) : null;
}

function mapMedia(row: MediaRow): CanonicalMediaRecord {
  return {
    id: row.id,
    familyId: row.familyId,
    storageObjectId: row.storageObjectId,
    sourceUploadId: row.sourceUploadId,
    uploadedAt: row.uploadedAt,
    mediaType: row.mediaType,
    processingState: row.processingState,
    generation: BigInt(row.generation),
    recipeId: Number(row.recipeId),
    timelineKey: row.timelineKey,
    timelineBasis: row.timelineBasis,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function assertId(value: string) {
  if (!/^[1-9][0-9]*$/u.test(value)) {
    throw new MediaRepositoryError("NOT_FOUND");
  }
}
