import { randomBytes } from "node:crypto";
import type {
  Pool,
  PoolConnection,
  ResultSetHeader,
  RowDataPacket,
} from "mysql2/promise";
import { readPurgeIntent, purgeAudit } from "./purge-execution.js";
import { runCheckedTransaction } from "./connection.js";

export type PurgeProgress =
  "REQUESTED" | "DETACHED" | "FILES_REMOVED" | "COMPLETED";
export type PurgeFailureCategory =
  | "REFERENCE_CONFLICT"
  | "FILESYSTEM_UNCERTAIN"
  | "CAPACITY_UNAVAILABLE"
  | "TRANSIENT_DB"
  | "INVARIANT_VIOLATION";

// Every mutation here is a single, explicitly fenced statement. Callers must
// reconcile by operation ID after an unknown COMMIT; no primitive retries it.
export class PurgeIntentRepository {
  constructor(private readonly pool: Pool) {}

  // The later Trash transition passes its already-locked transaction here.
  // A duplicate is idempotent only when the complete historical identity
  // matches; another UNIQUE violation remains an error.
  async create(
    connection: PoolConnection,
    input: {
      familyId: string;
      operationId: string;
      mediaId: string;
      storageObjectId: string;
      sourceUploadId: string;
      lifecycleRevision: bigint;
      trashedAt: Date;
      purgeAfter: Date;
      requestSource: "MANUAL" | "SCHEDULED";
      actorMemberId: string | null;
      originalBytes: bigint;
    },
  ): Promise<{ id: string; created: boolean }> {
    if (
      input.lifecycleRevision < 1n ||
      input.originalBytes < 1n ||
      input.purgeAfter.getTime() - input.trashedAt.getTime() !==
        30 * 24 * 60 * 60 * 1000
    )
      throw new Error("PURGE_INVALID_IDENTITY");
    const existing = await this.findIdentityOn(
      connection,
      input.familyId,
      input.mediaId,
      input.lifecycleRevision,
    );
    if (existing) return this.classifyIdentity(existing, input);
    try {
      await connection.execute(
        `INSERT INTO purge_intents (family_id,operation_id,media_id,
          storage_object_id,source_upload_id,lifecycle_revision,trashed_at,
          purge_after,request_source,actor_member_id,original_bytes)
         VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
        [
          input.familyId,
          input.operationId,
          input.mediaId,
          input.storageObjectId,
          input.sourceUploadId,
          input.lifecycleRevision.toString(),
          input.trashedAt,
          input.purgeAfter,
          input.requestSource,
          input.actorMemberId,
          input.originalBytes.toString(),
        ],
      );
    } catch (error) {
      if (!(
        error &&
        typeof error === "object" &&
        "code" in error &&
        error.code === "ER_DUP_ENTRY"
      ))
        throw error;
      const duplicate = await this.findIdentityOn(
        connection,
        input.familyId,
        input.mediaId,
        input.lifecycleRevision,
      );
      if (!duplicate) throw error;
      return this.classifyIdentity(duplicate, input);
    }
    const [rows] = await connection.query<RowDataPacket[]>(
      "SELECT CAST(LAST_INSERT_ID() AS CHAR) id",
    );
    return { id: String(rows[0]!.id), created: true };
  }

  private classifyIdentity(
    row: RowDataPacket,
    input: {
      operationId: string;
      storageObjectId: string;
      sourceUploadId: string;
      trashedAt: Date;
      purgeAfter: Date;
      requestSource: string;
      actorMemberId: string | null;
      originalBytes: bigint;
    },
  ) {
    if (
      row.operationId !== input.operationId ||
      String(row.storageObjectId) !== input.storageObjectId ||
      String(row.sourceUploadId) !== input.sourceUploadId ||
      !(row.trashedAt instanceof Date) ||
      row.trashedAt.getTime() !== input.trashedAt.getTime() ||
      !(row.purgeAfter instanceof Date) ||
      row.purgeAfter.getTime() !== input.purgeAfter.getTime() ||
      row.requestSource !== input.requestSource ||
      String(row.actorMemberId ?? "") !== String(input.actorMemberId ?? "") ||
      BigInt(row.originalBytes) !== input.originalBytes
    ) {
      throw new Error("PURGE_IDENTITY_CONFLICT");
    }
    return { id: String(row.id), created: false };
  }

  private async findIdentityOn(
    connection: PoolConnection,
    familyId: string,
    mediaId: string,
    revision: bigint,
  ) {
    const [rows] = await connection.execute<RowDataPacket[]>(
      `SELECT CAST(id AS CHAR) id, operation_id operationId,
        CAST(storage_object_id AS CHAR) storageObjectId,
        CAST(source_upload_id AS CHAR) sourceUploadId,
        trashed_at trashedAt, purge_after purgeAfter,
        request_source requestSource, CAST(actor_member_id AS CHAR) actorMemberId,
        CAST(original_bytes AS CHAR) originalBytes
       FROM purge_intents WHERE family_id=? AND media_id=?
         AND lifecycle_revision=? FOR UPDATE`,
      [familyId, mediaId, revision.toString()],
    );
    return rows[0] ?? null;
  }

  async findIdentity(familyId: string, mediaId: string, revision: bigint) {
    const [rows] = await this.pool.execute<RowDataPacket[]>(
      `SELECT CAST(id AS CHAR) id, operation_id operationId, progress,
        execution_state executionState, CAST(lease_epoch AS CHAR) leaseEpoch
       FROM purge_intents WHERE family_id=? AND media_id=? AND lifecycle_revision=?`,
      [familyId, mediaId, revision.toString()],
    );
    return rows[0] ?? null;
  }

  async claim(workerId = randomBytes(16)) {
    if (workerId.length !== 16) throw new Error("INVALID_WORKER_ID");
    return runCheckedTransaction(this.pool, async (connection) => {
      const [rows] = await connection.execute<RowDataPacket[]>(
        `SELECT CAST(id AS CHAR) id, CAST(lease_epoch AS CHAR) epoch, execution_state executionState
         FROM purge_intents
         WHERE attempts < max_attempts AND
           ((execution_state IN ('QUEUED','RETRY_WAIT') AND available_at <= CURRENT_TIMESTAMP(3))
            OR (execution_state='RUNNING' AND locked_until < CURRENT_TIMESTAMP(3))
           )
         ORDER BY available_at,id LIMIT 1 FOR UPDATE SKIP LOCKED`,
      );
      const row = rows[0];
      if (!row) return null;
      if (row.executionState === "RUNNING") {
        const expired = await readPurgeIntent(connection, String(row.id));
        if (!expired) throw new Error("PURGE_STALE");
        await purgeAudit(
          connection,
          expired,
          "PURGE_FAILED",
          String(row.epoch),
          "TRANSIENT_DB",
        );
      }
      const epoch = BigInt(row.epoch) + 1n;
      const [changed] = await connection.execute<ResultSetHeader>(
        `UPDATE purge_intents SET execution_state='RUNNING', worker_id=?,
          lease_epoch=?, locked_at=CURRENT_TIMESTAMP(3),
          heartbeat_at=CURRENT_TIMESTAMP(3),
          locked_until=CURRENT_TIMESTAMP(3) + INTERVAL 90 SECOND,
          attempts=attempts+1, failure_category=NULL
         WHERE id=? AND lease_epoch=? AND attempts < max_attempts`,
        [workerId, epoch.toString(), row.id, row.epoch],
      );
      if (changed.affectedRows !== 1) return null;
      return { id: String(row.id), epoch, workerId };
    });
  }

  async heartbeat(lease: { id: string; epoch: bigint; workerId: Buffer }) {
    const [changed] = await this.pool.execute<ResultSetHeader>(
      `UPDATE purge_intents SET heartbeat_at=CURRENT_TIMESTAMP(3),
         locked_until=CURRENT_TIMESTAMP(3) + INTERVAL 90 SECOND
       WHERE id=? AND execution_state='RUNNING' AND lease_epoch=?
         AND worker_id=? AND locked_until > CURRENT_TIMESTAMP(3)`,
      [lease.id, lease.epoch.toString(), lease.workerId],
    );
    return changed.affectedRows === 1;
  }

  async advance(
    lease: { id: string; epoch: bigint; workerId: Buffer },
    from: Exclude<PurgeProgress, "COMPLETED">,
    to: Exclude<PurgeProgress, "REQUESTED">,
  ) {
    if (
      {
        REQUESTED: "DETACHED",
        DETACHED: "FILES_REMOVED",
        FILES_REMOVED: "COMPLETED",
      }[from] !== to
    )
      throw new Error("INVALID_PROGRESS_TRANSITION");
    const done = to === "COMPLETED";
    const [changed] = await this.pool.execute<ResultSetHeader>(
      `UPDATE purge_intents SET progress=?, execution_state=?,
         completed_at=IF(?=1,CURRENT_TIMESTAMP(3),NULL),
         worker_id=IF(?=1,NULL,worker_id),
         locked_at=IF(?=1,NULL,locked_at),
         heartbeat_at=IF(?=1,NULL,heartbeat_at),
         locked_until=IF(?=1,NULL,locked_until)
       WHERE id=? AND progress=? AND execution_state='RUNNING'
         AND lease_epoch=? AND worker_id=? AND locked_until > CURRENT_TIMESTAMP(3)`,
      [
        to,
        done ? "DONE" : "RUNNING",
        Number(done),
        Number(done),
        Number(done),
        Number(done),
        Number(done),
        lease.id,
        from,
        lease.epoch.toString(),
        lease.workerId,
      ],
    );
    return changed.affectedRows === 1;
  }

  async fail(
    lease: { id: string; epoch: bigint; workerId: Buffer },
    category: PurgeFailureCategory,
    retryDelaySeconds: number | null,
  ) {
    if (
      retryDelaySeconds !== null &&
      (!Number.isSafeInteger(retryDelaySeconds) ||
        retryDelaySeconds < 30 ||
        retryDelaySeconds > 3600)
    )
      throw new Error("PURGE_INVALID_RETRY_DELAY");
    return runCheckedTransaction(this.pool, async (connection) => {
      const [changed] = await connection.execute<ResultSetHeader>(
        `UPDATE purge_intents SET
        execution_state=IF(? IS NULL OR attempts>=max_attempts,'BLOCKED','RETRY_WAIT'),
        failure_category=?,
        available_at=IF(? IS NULL,available_at,CURRENT_TIMESTAMP(3) + INTERVAL ? SECOND),
        worker_id=NULL,
        locked_at=NULL, heartbeat_at=NULL, locked_until=NULL
       WHERE id=? AND execution_state='RUNNING' AND lease_epoch=?
         AND worker_id=? AND locked_until > CURRENT_TIMESTAMP(3)`,
        [
          retryDelaySeconds,
          category,
          retryDelaySeconds,
          retryDelaySeconds,
          lease.id,
          lease.epoch.toString(),
          lease.workerId,
        ],
      );
      if (changed.affectedRows === 1) {
        const p = await readPurgeIntent(connection, lease.id);
        if (!p) throw new Error("PURGE_STALE");
        await purgeAudit(
          connection,
          p,
          "PURGE_FAILED",
          lease.epoch.toString(),
          category,
        );
      }
      return changed.affectedRows === 1;
    });
  }

  async recoverExhausted(connection: PoolConnection) {
    const [rows] = await connection.execute<RowDataPacket[]>(
      `SELECT CAST(id AS CHAR) id,CAST(lease_epoch AS CHAR) epoch FROM purge_intents
       WHERE execution_state='RUNNING' AND attempts>=max_attempts
         AND locked_until < CURRENT_TIMESTAMP(3) FOR UPDATE`,
    );
    for (const row of rows) {
      await connection.execute(
        `UPDATE purge_intents SET execution_state='BLOCKED',failure_category='TRANSIENT_DB',
        worker_id=NULL,locked_at=NULL,heartbeat_at=NULL,locked_until=NULL WHERE id=?`,
        [row.id],
      );
      const p = await readPurgeIntent(connection, row.id);
      if (!p) throw new Error("PURGE_STALE");
      await purgeAudit(
        connection,
        p,
        "PURGE_FAILED",
        row.epoch,
        "TRANSIENT_DB",
      );
    }
    return rows.length;
  }

  async manifest(familyId: string, intentId: string) {
    const [rows] = await this.pool.execute<RowDataPacket[]>(
      `SELECT * FROM purge_files WHERE family_id=? AND purge_intent_id=? ORDER BY id`,
      [familyId, intentId],
    );
    return rows;
  }
}

export type AuditAction =
  | "TRASH"
  | "RESTORE"
  | "PERMANENT_DELETE_REQUEST"
  | "PURGE_STARTED"
  | "PURGE_COMPLETED"
  | "PURGE_FAILED";

export class AuditRepository {
  constructor(private readonly pool: Pool) {}
  async append(input: {
    familyId: string;
    operationId: string;
    purgeIntentId: string | null;
    mediaId: string;
    storageObjectId: string;
    actorKind: "MEMBER" | "SYSTEM";
    actorMemberId: string | null;
    action: AuditAction;
    lifecycleRevision: bigint;
    transitionId: string;
    resultCategory: "SUCCESS" | PurgeFailureCategory;
  }) {
    const [changed] = await this.pool.execute<ResultSetHeader>(
      `INSERT INTO audit_logs (family_id,operation_id,purge_intent_id,media_id,
        storage_object_id,actor_kind,actor_member_id,action,lifecycle_revision,
        transition_id,result_category) VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      [
        input.familyId,
        input.operationId,
        input.purgeIntentId,
        input.mediaId,
        input.storageObjectId,
        input.actorKind,
        input.actorMemberId,
        input.action,
        input.lifecycleRevision.toString(),
        input.transitionId,
        input.resultCategory,
      ],
    );
    return String(changed.insertId);
  }
}
