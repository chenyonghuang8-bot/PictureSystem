import { randomUUID } from "node:crypto";
import type { Pool, RowDataPacket, ResultSetHeader } from "mysql2/promise";
import { runCheckedTransaction, readServerTime } from "./connection.js";
import { PurgeIntentRepository } from "./purge-repository.js";

export type ScheduledPurgeCandidate = {
  familyId: string;
  mediaId: string;
  storageId: string;
  sourceId: string;
  revision: string;
  sha256Hex: string;
  byteSize: string;
  purgeAfter: Date;
};
export class PurgeScheduleRepository {
  constructor(private readonly pool: Pool) {}
  async candidates(
    limit: number,
    after?: { purgeAfter: Date; mediaId: string },
  ) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100)
      throw new Error("PURGE_SCAN_LIMIT");
    const [rows] = await this.pool.query<RowDataPacket[]>(
      `SELECT CAST(m.family_id AS CHAR) familyId,CAST(m.id AS CHAR) mediaId,
       CAST(m.storage_object_id AS CHAR) storageId,CAST(m.source_upload_id AS CHAR) sourceId,
       CAST(m.lifecycle_revision AS CHAR) revision,LOWER(HEX(s.sha256)) sha256Hex,
       CAST(s.byte_size AS CHAR) byteSize,m.purge_after purgeAfter FROM media_items m
       JOIN storage_objects s ON s.family_id=m.family_id AND s.id=m.storage_object_id
       WHERE m.trashed_at IS NOT NULL AND m.purge_intent_id IS NULL
        AND m.purge_after<=CURRENT_TIMESTAMP(3) AND s.state='AVAILABLE'
        AND (?=0 OR m.purge_after>? OR (m.purge_after=? AND m.id>?))
       ORDER BY m.purge_after,m.id LIMIT ?`,
      [
        after ? 1 : 0,
        after?.purgeAfter ?? new Date(0),
        after?.purgeAfter ?? new Date(0),
        after?.mediaId ?? "0",
        limit,
      ],
    );
    return rows as (RowDataPacket & ScheduledPurgeCandidate)[];
  }
  async request(
    candidate: ScheduledPurgeCandidate,
    operationId = randomUUID(),
  ) {
    return runCheckedTransaction(this.pool, async (connection) => {
      await connection.execute(
        "SELECT id FROM families WHERE id=? FOR UPDATE",
        [candidate.familyId],
      );
      const [storages] = await connection.execute<RowDataPacket[]>(
        `SELECT state,LOWER(HEX(sha256)) sha256Hex,CAST(byte_size AS CHAR) byteSize
         FROM storage_objects WHERE family_id=? AND id=? FOR UPDATE`,
        [candidate.familyId, candidate.storageId],
      );
      const [media] = await connection.execute<RowDataPacket[]>(
        `SELECT CAST(storage_object_id AS CHAR) storageId,CAST(source_upload_id AS CHAR) sourceId,
          CAST(lifecycle_revision AS CHAR) revision,trashed_at trashedAt,purge_after purgeAfter,
          CAST(purge_intent_id AS CHAR) intentId FROM media_items WHERE family_id=? AND id=? FOR UPDATE`,
        [candidate.familyId, candidate.mediaId],
      );
      const now = await readServerTime(connection),
        item = media[0],
        storage = storages[0];
      if (
        !item ||
        !storage ||
        item.intentId ||
        !item.trashedAt ||
        !item.purgeAfter ||
        item.purgeAfter.getTime() > now.getTime() ||
        item.storageId !== candidate.storageId ||
        item.sourceId !== candidate.sourceId ||
        item.revision !== candidate.revision ||
        storage.state !== "AVAILABLE" ||
        storage.sha256Hex !== candidate.sha256Hex ||
        storage.byteSize !== candidate.byteSize ||
        BigInt(item.revision) === 18446744073709551615n
      )
        return null;
      const revision = BigInt(item.revision) + 1n;
      const intent = await new PurgeIntentRepository(this.pool).create(
        connection,
        {
          familyId: candidate.familyId,
          operationId,
          mediaId: candidate.mediaId,
          storageObjectId: candidate.storageId,
          sourceUploadId: candidate.sourceId,
          lifecycleRevision: revision,
          trashedAt: item.trashedAt,
          purgeAfter: item.purgeAfter,
          requestSource: "SCHEDULED",
          actorMemberId: null,
          originalBytes: BigInt(candidate.byteSize),
        },
      );
      if (!intent.created) throw new Error("PURGE_SCHEDULE_IDENTITY");
      const [changed] = await connection.execute<ResultSetHeader>(
        `UPDATE media_items SET lifecycle_revision=lifecycle_revision+1,purge_intent_id=?
         WHERE family_id=? AND id=? AND lifecycle_revision=? AND purge_intent_id IS NULL
          AND trashed_at IS NOT NULL AND purge_after<=CURRENT_TIMESTAMP(3)`,
        [intent.id, candidate.familyId, candidate.mediaId, candidate.revision],
      );
      if (changed.affectedRows !== 1) throw new Error("PURGE_STALE");
      await connection.execute(
        `INSERT INTO audit_logs (family_id,operation_id,purge_intent_id,media_id,storage_object_id,
          actor_kind,actor_member_id,action,lifecycle_revision,transition_id,result_category)
         VALUES (?,?,?,?,?,'SYSTEM',NULL,'PERMANENT_DELETE_REQUEST',?,?,'SUCCESS')`,
        [
          candidate.familyId,
          operationId,
          intent.id,
          candidate.mediaId,
          candidate.storageId,
          revision.toString(),
          operationId,
        ],
      );
      return { id: intent.id, operationId };
    });
  }
}
