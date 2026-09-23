import { randomBytes } from "node:crypto";

import type {
  Pool,
  PoolConnection,
  ResultSetHeader,
  RowDataPacket,
} from "mysql2/promise";

import {
  acquireCheckedConnection,
  readServerTime,
  runCheckedTransaction,
} from "./connection.js";
import {
  correlateDerivedFilesystemInventory,
  readDerivedCapacityInventory,
  readUploadCapacityInventory,
  RESERVED_FUTURE_SQL,
  RETAINED_STAGING_SQL,
  type DerivedFilesystemObservation,
} from "./capacity-inventory.js";
import { runCapacityTransaction } from "./capacity-transaction.js";
import { assertMigrationReadiness } from "./migration-readiness.js";
import type { Phase1CActor } from "./phase1c-repository.js";
import { CommitOutcomeUnknownError } from "./transaction.js";

const IDLE_TIMEOUT_MS = 7 * 24 * 60 * 60_000;
const UPLOAD_LIFETIME_MS = 7 * 24 * 60 * 60_000;
const ACTIVE_STATES = ["CREATED", "UPLOADING"] as const;
const GLOBAL_ACTIVE_DECLARED_BUDGET = 128n * 1_024n ** 3n;
const SCRATCH_RESERVE = 64n * 1_024n ** 2n;
const MIN_FREE_RESERVE = 10n * 1_024n ** 3n;

export const uploadFailureCodes = [
  "STAGING_CREATE_FAILED",
  "STAGING_INTEGRITY_MISMATCH",
  "STORAGE_WRITE_FAILED",
  "FINALIZE_SIZE_MISMATCH",
  "FINALIZE_HASH_MISMATCH",
  "ORIGINAL_INTEGRITY_MISMATCH",
] as const;
export type UploadFailureCode = (typeof uploadFailureCodes)[number];

export type UploadState =
  | "CREATED"
  | "UPLOADING"
  | "FINALIZING"
  | "COMPLETE"
  | "FAILED"
  | "ABORTED"
  | "EXPIRED";

export type UploadRecord = {
  id: string;
  publicId: string;
  familyId: string;
  createdByMemberId: string;
  declaredSize: bigint;
  committedOffset: bigint;
  state: UploadState;
  expiresAt: Date;
  createdAt: Date;
  updatedAt?: Date;
  completedAt: Date | null;
  computedSha256: Buffer | null;
  finalizeStartedAt: Date | null;
  storageObjectId: string | null;
  failureCode: UploadFailureCode | null;
  stagingCleanedAt: Date | null;
  terminalAt?: Date | null;
};

export type CreateUploadInput = {
  actor: Phase1CActor;
  familyId: string;
  publicId: Buffer;
  originalFilename: string;
  reportedMime: string | null;
  declaredSize: bigint;
};

export class UploadRepositoryError extends Error {
  constructor(
    readonly reason:
      | "UNAUTHENTICATED"
      | "NOT_FOUND"
      | "OFFSET_MISMATCH"
      | "UPLOAD_STATE_CONFLICT"
      | "UPLOAD_EXPIRED"
      | "QUOTA_EXCEEDED"
      | "CAPACITY_EXCEEDED"
      | "CONFLICT",
    readonly currentOffset?: bigint,
  ) {
    super(reason);
    this.name = "UploadRepositoryError";
  }
}

type UserRow = RowDataPacket & { disabledAt: Date | null };
type SessionRow = RowDataPacket & {
  tokenHash: Buffer;
  clientType: "WEB" | "ANDROID";
  lastSeenAt: Date;
  expiresAt: Date;
  revokedAt: Date | null;
};
type MemberRow = RowDataPacket & {
  id: string;
  userId: string;
  disabledAt: Date | null;
  leftAt: Date | null;
};
type UploadRow = RowDataPacket & {
  id: string;
  publicId: Buffer;
  familyId: string;
  createdByMemberId: string;
  declaredSize: string;
  committedOffset: string;
  state: UploadState;
  expiresAt: Date;
  createdAt: Date;
  updatedAt: Date;
  completedAt: Date | null;
  computedSha256: Buffer | null;
  finalizeStartedAt: Date | null;
  storageObjectId: string | null;
  failureCode: string | null;
  stagingCleanedAt: Date | null;
  terminalAt: Date | null;
};
type ObjectRow = RowDataPacket & {
  id: string;
  sha256: Buffer;
  byteSize: string;
  keyVersion: number;
  state: "AVAILABLE" | "MISSING" | "CORRUPT";
};

export type StorageObjectRecord = {
  id: string;
  sha256: Buffer;
  byteSize: bigint;
  keyVersion: number;
  state: ObjectRow["state"];
};

export class MySqlUploadRepository {
  constructor(private readonly pool: Pool) {}

  async assertRecoveryReadiness() {
    const connection = await acquireCheckedConnection(this.pool);
    try {
      const [rows] = await connection.query<RowDataPacket[]>(
        `SELECT DATABASE() AS dbName, VERSION() AS mysqlVersion,
          CURRENT_USER() AS currentUser,
          @@GLOBAL.innodb_flush_log_at_trx_commit AS flushAtCommit`,
      );
      const row = rows[0];
      if (
        !row ||
        row.dbName !== "family_album_dev" ||
        !String(row.mysqlVersion).startsWith("9.7.2") ||
        String(row.currentUser).split("@")[0]?.toLowerCase() === "root" ||
        Number(row.flushAtCommit) !== 1
      )
        throw new Error("STORAGE_RECOVERY_DB_PREFLIGHT_FAILED");
      await assertMigrationReadiness(connection);
    } finally {
      connection.release();
    }
  }

  async recoveryServerTime() {
    const connection = await acquireCheckedConnection(this.pool);
    try {
      return await readServerTime(connection);
    } finally {
      connection.release();
    }
  }

  async scanUploads(
    afterId: string,
    limit: number,
    familyScope?: string,
  ): Promise<UploadRecord[]> {
    assertScanLimit(afterId, limit);
    if (familyScope !== undefined && !/^[1-9][0-9]*$/u.test(familyScope))
      throw new TypeError("RECOVERY_FAMILY_SCOPE_INVALID");
    const connection = await acquireCheckedConnection(this.pool);
    try {
      const [rows] = await connection.query<UploadRow[]>(
        `${uploadColumns()} FROM upload_sessions WHERE id > ?
          ${familyScope === undefined ? "" : "AND family_id=?"}
          ORDER BY id ASC LIMIT ?`,
        familyScope === undefined
          ? [afterId, limit]
          : [afterId, familyScope, limit],
      );
      return rows.map(mapUpload);
    } finally {
      connection.release();
    }
  }

  async scanRecoveryUploads(
    afterId: string,
    limit: number,
    familyScope?: string,
  ) {
    assertScanLimit(afterId, limit);
    if (familyScope !== undefined && !/^[1-9][0-9]*$/u.test(familyScope))
      throw new TypeError("RECOVERY_FAMILY_SCOPE_INVALID");
    const connection = await acquireCheckedConnection(this.pool);
    try {
      const [rows] = await connection.query<UploadRow[]>(
        `${uploadColumns()} FROM upload_sessions
          WHERE id > ? ${familyScope === undefined ? "" : "AND family_id=?"}
            AND (state IN ('CREATED','UPLOADING','FINALIZING')
            OR (state IN ('COMPLETE','ABORTED','EXPIRED')
                AND staging_cleaned_at IS NULL))
          ORDER BY id ASC LIMIT ?`,
        familyScope === undefined
          ? [afterId, limit]
          : [afterId, familyScope, limit],
      );
      return rows.map(mapUpload);
    } finally {
      connection.release();
    }
  }

  async scanStorageObjects(
    afterId: string,
    limit: number,
    familyScope?: string,
  ) {
    assertScanLimit(afterId, limit);
    if (familyScope !== undefined && !/^[1-9][0-9]*$/u.test(familyScope))
      throw new TypeError("RECOVERY_FAMILY_SCOPE_INVALID");
    const connection = await acquireCheckedConnection(this.pool);
    try {
      const [rows] = await connection.query<
        (ObjectRow & { familyId: string })[]
      >(
        `SELECT CAST(id AS CHAR) AS id, CAST(family_id AS CHAR) AS familyId,
          sha256, CAST(byte_size AS CHAR) AS byteSize,
          key_version AS keyVersion, state
         FROM storage_objects WHERE id > ?
           ${familyScope === undefined ? "" : "AND family_id=?"}
           ORDER BY id ASC LIMIT ?`,
        familyScope === undefined
          ? [afterId, limit]
          : [afterId, familyScope, limit],
      );
      return rows.map((row) => ({ ...mapObject(row), familyId: row.familyId }));
    } finally {
      connection.release();
    }
  }

  async findFinalizingIntent(input: {
    familyId: string;
    sha256: Buffer;
    byteSize: bigint;
  }): Promise<boolean> {
    const connection = await acquireCheckedConnection(this.pool);
    try {
      const [rows] = await connection.query<RowDataPacket[]>(
        `SELECT CAST(id AS CHAR) AS id FROM upload_sessions
           WHERE family_id=? AND computed_sha256=? AND declared_size=?
             AND state='FINALIZING' LIMIT 1`,
        [input.familyId, input.sha256, input.byteSize.toString()],
      );
      return rows.length > 0;
    } finally {
      connection.release();
    }
  }

  async systemRevalidate(publicId: Buffer, expire: boolean) {
    return runCheckedTransaction(this.pool, async (connection) => {
      const location = await locateUpload(connection, publicId);
      if (!location) throw new UploadRepositoryError("NOT_FOUND");
      await lockFamily(connection, location.familyId);
      const upload = await this.readLockedByPublicId(connection, publicId);
      if (upload.familyId !== location.familyId)
        throw new UploadRepositoryError("CONFLICT");
      const now = await readServerTime(connection);
      if (
        expire &&
        ACTIVE_STATES.includes(
          upload.state as (typeof ACTIVE_STATES)[number],
        ) &&
        now >= upload.expiresAt
      ) {
        const [changed] = await connection.execute<ResultSetHeader>(
          `UPDATE upload_sessions SET state='EXPIRED', terminal_at=?, updated_at=?
            WHERE id=? AND public_id=? AND state IN ('CREATED','UPLOADING')
              AND expires_at <= ?`,
          [now, now, upload.id, publicId, now],
        );
        if (changed.affectedRows !== 1)
          throw new UploadRepositoryError("CONFLICT");
        return {
          upload: { ...upload, state: "EXPIRED" as const, terminalAt: now },
          expiredTransitioned: true as const,
        };
      }
      return { upload, expiredTransitioned: false as const };
    });
  }

  async systemFailStaging(publicId: Buffer) {
    return runCheckedTransaction(this.pool, async (connection) => {
      const location = await locateUpload(connection, publicId);
      if (!location) throw new UploadRepositoryError("NOT_FOUND");
      await lockFamily(connection, location.familyId);
      const upload = await this.readLockedByPublicId(connection, publicId);
      if (
        !ACTIVE_STATES.includes(upload.state as (typeof ACTIVE_STATES)[number])
      )
        return upload;
      const now = await readServerTime(connection);
      const [changed] = await connection.execute<ResultSetHeader>(
        `UPDATE upload_sessions SET state='FAILED', terminal_at=?,
          failure_code='STAGING_INTEGRITY_MISMATCH', updated_at=?
         WHERE id=? AND public_id=? AND state IN ('CREATED','UPLOADING')`,
        [now, now, upload.id, publicId],
      );
      if (changed.affectedRows !== 1)
        throw new UploadRepositoryError("CONFLICT");
      return { ...upload, state: "FAILED" as const, terminalAt: now };
    });
  }

  async admissionUsage() {
    const connection = await acquireCheckedConnection(this.pool);
    try {
      return await readUploadCapacityInventory(connection);
    } finally {
      connection.release();
    }
  }

  async createUpload(input: CreateUploadInput): Promise<UploadRecord> {
    return runCheckedTransaction(this.pool, (connection) =>
      this.createUploadInTransaction(connection, input),
    );
  }

  /**
   * Shared-barrier variant used only when an API coordinator already owns the
   * root-local capacity gate. The final statfs callback is invoked after the
   * session barrier, current SQL inventory and authorization locks.
   */
  async createUploadCapacityAdmitted(
    input: CreateUploadInput,
    deadline: number,
    finalCapacitySnapshot: () => {
      totalBytes: bigint;
      availableBytes: bigint;
      derivedInventoryComplete: boolean;
      derivedObservations?: readonly DerivedFilesystemObservation[] | undefined;
    },
  ): Promise<UploadRecord> {
    const outcome = await runCapacityTransaction(
      this.pool,
      deadline,
      (connection) =>
        this.createUploadInTransaction(connection, input, async () => {
          const upload = await readUploadCapacityInventory(connection);
          const derived = await readDerivedCapacityInventory(connection);
          if (
            upload.outstanding + input.declaredSize >
            GLOBAL_ACTIVE_DECLARED_BUDGET
          ) {
            throw new UploadRepositoryError("QUOTA_EXCEEDED");
          }
          const physical = finalCapacitySnapshot();
          const correlated = await correlateDerivedFilesystemInventory(
            connection,
            physical.derivedInventoryComplete
              ? physical.derivedObservations
              : undefined,
          );
          if (
            !physical.derivedInventoryComplete ||
            !correlated.complete ||
            physical.totalBytes <= 0n ||
            physical.availableBytes < 0n
          ) {
            throw new UploadRepositoryError("CAPACITY_EXCEEDED");
          }
          const reserve =
            physical.totalBytes / 10n > MIN_FREE_RESERVE
              ? physical.totalBytes / 10n
              : MIN_FREE_RESERVE;
          if (
            physical.availableBytes <
            reserve +
              SCRATCH_RESERVE +
              upload.reservedFutureBytes +
              derived.unsettled +
              input.declaredSize
          ) {
            throw new UploadRepositoryError("CAPACITY_EXCEEDED");
          }
        }),
    );
    if (outcome.transaction === "COMMITTED" && !outcome.deadlineExceeded) {
      return outcome.value;
    }
    if (outcome.transaction === "ROLLED_BACK") {
      throw outcome.error;
    }
    throw new CommitOutcomeUnknownError();
  }

  private async createUploadInTransaction(
    connection: PoolConnection,
    input: CreateUploadInput,
    beforeInsert?: () => Promise<void>,
  ): Promise<UploadRecord> {
    const memberId = await locateMemberId(
      connection,
      input.familyId,
      input.actor.userId,
    );
    if (!memberId) throw new UploadRepositoryError("NOT_FOUND");
    await lockFamily(connection, input.familyId);
    const auth = await lockActor(
      connection,
      input.familyId,
      memberId,
      input.actor,
    );
    const now = await readServerTime(connection);
    assertActor(auth, input.actor, now);

    const [counts] = await connection.query<RowDataPacket[]>(
      `SELECT
           SUM(created_by_member_id = ? AND state IN ('CREATED','UPLOADING')) AS memberActive,
           SUM(state IN ('CREATED','UPLOADING')) AS familyActive
         FROM upload_sessions WHERE family_id = ?`,
      [memberId, input.familyId],
    );
    if (
      Number(counts[0]?.memberActive ?? 0) >= 4 ||
      Number(counts[0]?.familyActive ?? 0) >= 16
    ) {
      throw new UploadRepositoryError("QUOTA_EXCEEDED");
    }
    const [logical] = await connection.query<RowDataPacket[]>(
      `SELECT CAST(
           COALESCE((SELECT SUM(byte_size) FROM storage_objects WHERE family_id = ?),0) +
           COALESCE((SELECT SUM(${RESERVED_FUTURE_SQL} + ${RETAINED_STAGING_SQL})
             FROM upload_sessions WHERE family_id = ?),0)
           AS CHAR) AS bytes`,
      [input.familyId, input.familyId],
    );
    if (
      BigInt(String(logical[0]?.bytes ?? "0")) + input.declaredSize >
      256n * 1024n ** 3n
    ) {
      throw new UploadRepositoryError("QUOTA_EXCEEDED");
    }

    await beforeInsert?.();
    const expiresAt = new Date(now.getTime() + UPLOAD_LIFETIME_MS);
    await connection.execute<ResultSetHeader>(
      `INSERT INTO upload_sessions
          (public_id, family_id, created_by_member_id, original_filename,
           reported_mime, declared_size, committed_offset, state, expires_at,
           created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 0, 'CREATED', ?, ?, ?)`,
      [
        input.publicId,
        input.familyId,
        memberId,
        input.originalFilename,
        input.reportedMime,
        input.declaredSize.toString(),
        expiresAt,
        now,
        now,
      ],
    );
    return this.readLockedByPublicId(connection, input.publicId);
  }

  async inspect(input: {
    actor: Phase1CActor;
    publicId: Buffer;
    expectedOffset?: bigint;
    allowTerminal?: boolean;
    transitionExpiry?: boolean;
  }): Promise<UploadRecord> {
    const result = await runCheckedTransaction(
      this.pool,
      async (connection) => {
        const location = await locateUpload(connection, input.publicId);
        if (!location) throw new UploadRepositoryError("NOT_FOUND");
        const memberId = await locateMemberId(
          connection,
          location.familyId,
          input.actor.userId,
        );
        if (!memberId) throw new UploadRepositoryError("NOT_FOUND");
        await lockFamily(connection, location.familyId);
        const auth = await lockActor(
          connection,
          location.familyId,
          memberId,
          input.actor,
        );
        const upload = await this.readLockedByPublicId(
          connection,
          input.publicId,
        );
        const now = await readServerTime(connection);
        assertActor(auth, input.actor, now);
        assertOwner(upload, memberId);
        if (
          input.transitionExpiry === false &&
          ACTIVE_STATES.includes(
            upload.state as (typeof ACTIVE_STATES)[number],
          ) &&
          now >= upload.expiresAt
        ) {
          return {
            rejectExpired: !input.allowTerminal,
            upload: { ...upload, state: "EXPIRED" as const },
          };
        }
        if (await expireIfNeeded(connection, upload, now)) {
          return { rejectExpired: !input.allowTerminal, upload };
        }
        if (!input.allowTerminal) assertMutable(upload);
        if (
          input.expectedOffset !== undefined &&
          upload.committedOffset !== input.expectedOffset
        ) {
          throw new UploadRepositoryError(
            "OFFSET_MISMATCH",
            upload.committedOffset,
          );
        }
        return { rejectExpired: false as const, upload };
      },
    );
    if (result.rejectExpired) throw new UploadRepositoryError("UPLOAD_EXPIRED");
    return result.upload;
  }

  async advanceOffset(input: {
    actor: Phase1CActor;
    publicId: Buffer;
    expectedOffset: bigint;
    durableBytes: bigint;
  }): Promise<UploadRecord> {
    const result = await runCheckedTransaction(
      this.pool,
      async (connection) => {
        const location = await locateUpload(connection, input.publicId);
        if (!location) throw new UploadRepositoryError("NOT_FOUND");
        const memberId = await locateMemberId(
          connection,
          location.familyId,
          input.actor.userId,
        );
        if (!memberId) throw new UploadRepositoryError("NOT_FOUND");
        await lockFamily(connection, location.familyId);
        const auth = await lockActor(
          connection,
          location.familyId,
          memberId,
          input.actor,
        );
        const upload = await this.readLockedByPublicId(
          connection,
          input.publicId,
        );
        const now = await readServerTime(connection);
        assertActor(auth, input.actor, now);
        assertOwner(upload, memberId);
        if (await expireIfNeeded(connection, upload, now)) {
          return { expired: true as const, upload };
        }
        assertMutable(upload);
        if (upload.committedOffset !== input.expectedOffset) {
          throw new UploadRepositoryError(
            "OFFSET_MISMATCH",
            upload.committedOffset,
          );
        }
        const next = input.expectedOffset + input.durableBytes;
        if (input.durableBytes <= 0n || next > upload.declaredSize) {
          throw new UploadRepositoryError("CONFLICT");
        }
        const [result] = await connection.execute<ResultSetHeader>(
          `UPDATE upload_sessions
            SET committed_offset = ?, state = 'UPLOADING', updated_at = ?
          WHERE id = ? AND state IN ('CREATED','UPLOADING')
            AND committed_offset = ? AND declared_size >= ?`,
          [
            next.toString(),
            now,
            upload.id,
            input.expectedOffset.toString(),
            next.toString(),
          ],
        );
        if (result.affectedRows !== 1) {
          throw new UploadRepositoryError("CONFLICT");
        }
        return {
          expired: false as const,
          upload: {
            ...upload,
            committedOffset: next,
            state: "UPLOADING" as const,
          },
        };
      },
    );
    if (result.expired) throw new UploadRepositoryError("UPLOAD_EXPIRED");
    return result.upload;
  }

  async abort(input: { actor: Phase1CActor; publicId: Buffer }) {
    const result = await runCheckedTransaction(
      this.pool,
      async (connection) => {
        const location = await locateUpload(connection, input.publicId);
        if (!location) throw new UploadRepositoryError("NOT_FOUND");
        const memberId = await locateMemberId(
          connection,
          location.familyId,
          input.actor.userId,
        );
        if (!memberId) throw new UploadRepositoryError("NOT_FOUND");
        await lockFamily(connection, location.familyId);
        const auth = await lockActor(
          connection,
          location.familyId,
          memberId,
          input.actor,
        );
        const upload = await this.readLockedByPublicId(
          connection,
          input.publicId,
        );
        const now = await readServerTime(connection);
        assertActor(auth, input.actor, now);
        assertOwner(upload, memberId);
        if (await expireIfNeeded(connection, upload, now)) {
          return { expired: true as const, upload, changed: true };
        }
        if (upload.state === "ABORTED") return { upload, changed: false };
        if (
          !ACTIVE_STATES.includes(
            upload.state as (typeof ACTIVE_STATES)[number],
          )
        ) {
          throw new UploadRepositoryError("UPLOAD_STATE_CONFLICT");
        }
        const [result] = await connection.execute<ResultSetHeader>(
          `UPDATE upload_sessions SET state='ABORTED', terminal_at=?, updated_at=?
          WHERE id=? AND state IN ('CREATED','UPLOADING')`,
          [now, now, upload.id],
        );
        if (result.affectedRows !== 1)
          throw new UploadRepositoryError("CONFLICT");
        return {
          expired: false as const,
          upload: { ...upload, state: "ABORTED" as const },
          changed: true,
        };
      },
    );
    if ("expired" in result && result.expired) {
      throw new UploadRepositoryError("UPLOAD_EXPIRED");
    }
    return result;
  }

  async markCleaned(publicId: Buffer) {
    return runCheckedTransaction(this.pool, async (connection) => {
      const upload = await this.readLockedByPublicId(connection, publicId);
      if (
        !["ABORTED", "EXPIRED", "FAILED", "COMPLETE"].includes(upload.state)
      ) {
        throw new UploadRepositoryError("UPLOAD_STATE_CONFLICT");
      }
      const now = await readServerTime(connection);
      if (upload.stagingCleanedAt) return;
      const [changed] = await connection.execute<ResultSetHeader>(
        `UPDATE upload_sessions SET staging_cleaned_at=COALESCE(staging_cleaned_at, ?), updated_at=?
          WHERE id=? AND public_id=? AND state IN ('ABORTED','EXPIRED','FAILED','COMPLETE')
            AND staging_cleaned_at IS NULL`,
        [now, now, upload.id, publicId],
      );
      if (changed.affectedRows !== 1)
        throw new UploadRepositoryError("CONFLICT");
    });
  }

  async markFailed(publicId: Buffer, failureCode: unknown) {
    if (!uploadFailureCodes.includes(failureCode as UploadFailureCode)) {
      throw new TypeError("UPLOAD_FAILURE_CODE_INVALID");
    }
    const controlledFailureCode = failureCode as UploadFailureCode;
    return runCheckedTransaction(this.pool, async (connection) => {
      const upload = await this.readLockedByPublicId(connection, publicId);
      if (
        !ACTIVE_STATES.includes(
          upload.state as (typeof ACTIVE_STATES)[number],
        ) &&
        upload.state !== "FINALIZING"
      )
        return;
      const now = await readServerTime(connection);
      const [result] = await connection.execute<ResultSetHeader>(
        `UPDATE upload_sessions SET state='FAILED', terminal_at=?, failure_code=?, updated_at=?
          WHERE id=? AND state IN ('CREATED','UPLOADING','FINALIZING')`,
        [now, controlledFailureCode, now, upload.id],
      );
      if (result.affectedRows !== 1)
        throw new UploadRepositoryError("CONFLICT");
    });
  }

  async trustedState(publicId: Buffer): Promise<UploadRecord> {
    const connection = await acquireCheckedConnection(this.pool);
    try {
      const [rows] = await connection.query<UploadRow[]>(uploadSelect(false), [
        publicId,
      ]);
      if (!rows[0]) throw new UploadRepositoryError("NOT_FOUND");
      return mapUpload(rows[0]);
    } finally {
      connection.release();
    }
  }

  async assertFinalizeDurability() {
    const connection = await acquireCheckedConnection(this.pool);
    try {
      const [rows] = await connection.query<RowDataPacket[]>(
        "SELECT @@GLOBAL.innodb_flush_log_at_trx_commit AS flushAtCommit",
      );
      if (Number(rows[0]?.flushAtCommit) !== 1) {
        throw new Error("DB_FINALIZE_DURABILITY_REQUIRED");
      }
    } finally {
      connection.release();
    }
  }

  async beginFinalize(input: {
    actor: Phase1CActor;
    publicId: Buffer;
    sha256: Buffer;
  }): Promise<UploadRecord> {
    if (input.sha256.length !== 32) throw new TypeError("HASH_LENGTH_INVALID");
    const result = await runCheckedTransaction(
      this.pool,
      async (connection) => {
        const { upload, memberId, now } = await this.lockAuthorizedUpload(
          connection,
          input.actor,
          input.publicId,
        );
        if (upload.state === "COMPLETE") {
          if (!upload.computedSha256?.equals(input.sha256))
            throw new UploadRepositoryError("CONFLICT");
          return { upload, expired: false };
        }
        if (upload.state === "FINALIZING") {
          if (!upload.computedSha256?.equals(input.sha256))
            throw new UploadRepositoryError("CONFLICT");
          return { upload, expired: false };
        }
        if (upload.state !== "UPLOADING")
          throw new UploadRepositoryError("UPLOAD_STATE_CONFLICT");
        if (upload.committedOffset !== upload.declaredSize)
          throw new UploadRepositoryError("UPLOAD_STATE_CONFLICT");
        if (await expireIfNeeded(connection, upload, now))
          return { upload, expired: true };
        assertOwner(upload, memberId);
        const [changed] = await connection.execute<ResultSetHeader>(
          `UPDATE upload_sessions SET state='FINALIZING', computed_sha256=?,
          finalize_started_at=?, updated_at=?
         WHERE id=? AND state='UPLOADING' AND committed_offset=declared_size
           AND computed_sha256 IS NULL AND finalize_started_at IS NULL`,
          [input.sha256, now, now, upload.id],
        );
        if (changed.affectedRows !== 1)
          throw new UploadRepositoryError("CONFLICT");
        return {
          expired: false,
          upload: {
            ...upload,
            state: "FINALIZING" as const,
            computedSha256: Buffer.from(input.sha256),
            finalizeStartedAt: now,
          },
        };
      },
    );
    if (result.expired) throw new UploadRepositoryError("UPLOAD_EXPIRED");
    return result.upload;
  }

  async findStorageObject(input: {
    familyId: string;
    sha256: Buffer;
    byteSize: bigint;
  }): Promise<StorageObjectRecord | null> {
    const connection = await acquireCheckedConnection(this.pool);
    try {
      const [rows] = await connection.query<ObjectRow[]>(objectSelect(false), [
        input.familyId,
        input.sha256,
        input.byteSize.toString(),
      ]);
      return rows[0] ? mapObject(rows[0]) : null;
    } finally {
      connection.release();
    }
  }

  async markStorageIntegrityIssue(input: {
    familyId: string;
    sha256: Buffer;
    byteSize: bigint;
    state: "MISSING" | "CORRUPT";
  }) {
    return runCheckedTransaction(this.pool, async (connection) => {
      await lockFamily(connection, input.familyId);
      const [rows] = await connection.query<ObjectRow[]>(objectSelect(true), [
        input.familyId,
        input.sha256,
        input.byteSize.toString(),
      ]);
      if (!rows[0]) return;
      const object = mapObject(rows[0]);
      if (object.state !== "AVAILABLE") return;
      const now = await readServerTime(connection);
      const [changed] = await connection.execute<ResultSetHeader>(
        "UPDATE storage_objects SET state=?, updated_at=? WHERE id=? AND state='AVAILABLE'",
        [input.state, now, object.id],
      );
      if (changed.affectedRows !== 1)
        throw new UploadRepositoryError("CONFLICT");
    });
  }

  async completeFinalize(input: {
    actor: Phase1CActor;
    publicId: Buffer;
    sha256: Buffer;
    byteSize: bigint;
  }): Promise<UploadRecord> {
    return runCheckedTransaction(this.pool, async (connection) => {
      const { upload, auth, now } = await this.lockAuthorizedUpload(
        connection,
        input.actor,
        input.publicId,
      );
      if (upload.state === "COMPLETE") {
        if (
          !upload.computedSha256?.equals(input.sha256) ||
          upload.declaredSize !== input.byteSize
        )
          throw new UploadRepositoryError("CONFLICT");
        const [completeRows] = await connection.query<ObjectRow[]>(
          objectSelect(true),
          [upload.familyId, input.sha256, input.byteSize.toString()],
        );
        if (
          !completeRows[0] ||
          mapObject(completeRows[0]).id !== upload.storageObjectId ||
          completeRows[0].state !== "AVAILABLE" ||
          Number(completeRows[0].keyVersion) !== 1
        )
          throw new UploadRepositoryError("CONFLICT");
        assertActor(auth, input.actor, await readServerTime(connection));
        return upload;
      }
      if (
        upload.state !== "FINALIZING" ||
        !upload.computedSha256?.equals(input.sha256) ||
        upload.declaredSize !== input.byteSize ||
        upload.committedOffset !== input.byteSize
      )
        throw new UploadRepositoryError("UPLOAD_STATE_CONFLICT");
      const [durability] = await connection.query<RowDataPacket[]>(
        "SELECT @@GLOBAL.innodb_flush_log_at_trx_commit AS flushAtCommit",
      );
      if (Number(durability[0]?.flushAtCommit) !== 1) {
        throw new Error("DB_FINALIZE_DURABILITY_REQUIRED");
      }
      const [rows] = await connection.query<ObjectRow[]>(objectSelect(true), [
        upload.familyId,
        input.sha256,
        input.byteSize.toString(),
      ]);
      let objectId: string;
      if (rows[0]) {
        const object = mapObject(rows[0]);
        if (
          object.state !== "AVAILABLE" ||
          object.keyVersion !== 1 ||
          object.byteSize !== input.byteSize ||
          !object.sha256.equals(input.sha256)
        )
          throw new UploadRepositoryError("CONFLICT");
        objectId = object.id;
      } else {
        await connection.execute<ResultSetHeader>(
          `INSERT INTO storage_objects
            (family_id,sha256,byte_size,key_version,state,durable_at,
             verified_at,created_at,updated_at)
           VALUES (?,?,?,1,'AVAILABLE',?,?,?,?)`,
          [
            upload.familyId,
            input.sha256,
            input.byteSize.toString(),
            now,
            now,
            now,
            now,
          ],
        );
        const [created] = await connection.query<ObjectRow[]>(
          objectSelect(true),
          [upload.familyId, input.sha256, input.byteSize.toString()],
        );
        if (!created[0]) throw new UploadRepositoryError("CONFLICT");
        objectId = mapObject(created[0]).id;
      }
      // The storage row/unique-key wait can cross an auth deadline. The first
      // server time guarded the upload lock; this fresh time guards completion.
      const completionNow = await readServerTime(connection);
      assertActor(auth, input.actor, completionNow);
      const [verified] = await connection.execute<ResultSetHeader>(
        `UPDATE storage_objects SET verified_at=?, updated_at=? WHERE id=?
           AND state='AVAILABLE' AND sha256=? AND byte_size=? AND key_version=1`,
        [
          completionNow,
          completionNow,
          objectId,
          input.sha256,
          input.byteSize.toString(),
        ],
      );
      if (verified.affectedRows !== 1)
        throw new UploadRepositoryError("CONFLICT");
      const [changed] = await connection.execute<ResultSetHeader>(
        `UPDATE upload_sessions SET state='COMPLETE', storage_object_id=?,
          completed_at=?, updated_at=?
         WHERE id=? AND state='FINALIZING' AND computed_sha256=?
           AND committed_offset=? AND declared_size=? AND storage_object_id IS NULL`,
        [
          objectId,
          completionNow,
          completionNow,
          upload.id,
          input.sha256,
          input.byteSize.toString(),
          input.byteSize.toString(),
        ],
      );
      if (changed.affectedRows !== 1)
        throw new UploadRepositoryError("CONFLICT");
      return {
        ...upload,
        state: "COMPLETE",
        storageObjectId: objectId,
        completedAt: completionNow,
      };
    });
  }

  private async lockAuthorizedUpload(
    connection: PoolConnection,
    actor: Phase1CActor,
    publicId: Buffer,
  ) {
    const location = await locateUpload(connection, publicId);
    if (!location) throw new UploadRepositoryError("NOT_FOUND");
    const memberId = await locateMemberId(
      connection,
      location.familyId,
      actor.userId,
    );
    if (!memberId) throw new UploadRepositoryError("NOT_FOUND");
    await lockFamily(connection, location.familyId);
    const auth = await lockActor(
      connection,
      location.familyId,
      memberId,
      actor,
    );
    const upload = await this.readLockedByPublicId(connection, publicId);
    const now = await readServerTime(connection);
    assertActor(auth, actor, now);
    assertOwner(upload, memberId);
    return { upload, memberId, auth, now };
  }

  private async readLockedByPublicId(
    connection: PoolConnection,
    publicId: Buffer,
  ) {
    const [rows] = await connection.query<UploadRow[]>(uploadSelect(true), [
      publicId,
    ]);
    if (!rows[0]) throw new UploadRepositoryError("NOT_FOUND");
    return mapUpload(rows[0]);
  }
}

async function locateUpload(connection: PoolConnection, publicId: Buffer) {
  const [rows] = await connection.query<RowDataPacket[]>(
    `SELECT CAST(family_id AS CHAR) AS familyId
       FROM upload_sessions WHERE public_id=? LIMIT 1`,
    [publicId],
  );
  return rows[0] ? { familyId: String(rows[0].familyId) } : undefined;
}

async function locateMemberId(
  connection: PoolConnection,
  familyId: string,
  userId: string,
) {
  const [rows] = await connection.query<RowDataPacket[]>(
    `SELECT CAST(id AS CHAR) AS id FROM family_members
      WHERE family_id=? AND user_id=? LIMIT 1`,
    [familyId, userId],
  );
  return rows[0] ? String(rows[0].id) : undefined;
}

async function lockFamily(connection: PoolConnection, familyId: string) {
  const [rows] = await connection.query<RowDataPacket[]>(
    "SELECT CAST(id AS CHAR) AS id FROM families WHERE id=? FOR UPDATE",
    [familyId],
  );
  if (!rows[0]) throw new UploadRepositoryError("NOT_FOUND");
}

async function lockActor(
  connection: PoolConnection,
  familyId: string,
  memberId: string,
  actor: Phase1CActor,
) {
  const [users] = await connection.query<UserRow[]>(
    "SELECT disabled_at AS disabledAt FROM users WHERE id=? FOR UPDATE",
    [actor.userId],
  );
  const [sessions] = await connection.query<SessionRow[]>(
    `SELECT token_hash AS tokenHash, client_type AS clientType,
            last_seen_at AS lastSeenAt, expires_at AS expiresAt,
            revoked_at AS revokedAt
       FROM sessions WHERE id=? AND user_id=? FOR UPDATE`,
    [actor.sessionId, actor.userId],
  );
  const [members] = await connection.query<MemberRow[]>(
    `SELECT CAST(id AS CHAR) AS id, CAST(user_id AS CHAR) AS userId,
            disabled_at AS disabledAt, left_at AS leftAt
       FROM family_members WHERE id=? AND family_id=? FOR UPDATE`,
    [memberId, familyId],
  );
  return { user: users[0], session: sessions[0], member: members[0] };
}

function assertActor(
  state: {
    user: UserRow | undefined;
    session: SessionRow | undefined;
    member: MemberRow | undefined;
  },
  actor: Phase1CActor,
  now: Date,
) {
  const { user, session, member } = state;
  if (
    !user ||
    !session ||
    !member ||
    user.disabledAt ||
    member.disabledAt ||
    member.leftAt ||
    member.userId !== actor.userId ||
    session.clientType !== "WEB" ||
    session.revokedAt ||
    !Buffer.isBuffer(session.tokenHash) ||
    !session.tokenHash.equals(actor.tokenHash) ||
    now >= session.expiresAt ||
    now.getTime() >= session.lastSeenAt.getTime() + IDLE_TIMEOUT_MS
  )
    throw new UploadRepositoryError("UNAUTHENTICATED");
}

function assertOwner(upload: UploadRecord, memberId: string) {
  if (upload.createdByMemberId !== memberId) {
    throw new UploadRepositoryError("NOT_FOUND");
  }
}

async function expireIfNeeded(
  connection: PoolConnection,
  upload: UploadRecord,
  now: Date,
) {
  if (
    ACTIVE_STATES.includes(upload.state as (typeof ACTIVE_STATES)[number]) &&
    now >= upload.expiresAt
  ) {
    await connection.execute<ResultSetHeader>(
      `UPDATE upload_sessions SET state='EXPIRED', terminal_at=?, updated_at=?
        WHERE id=? AND state IN ('CREATED','UPLOADING')`,
      [now, now, upload.id],
    );
    upload.state = "EXPIRED";
    return true;
  }
  return upload.state === "EXPIRED";
}

function assertMutable(upload: UploadRecord) {
  if (!ACTIVE_STATES.includes(upload.state as (typeof ACTIVE_STATES)[number])) {
    throw new UploadRepositoryError("UPLOAD_STATE_CONFLICT");
  }
}

function uploadSelect(lock: boolean) {
  return `${uploadColumns()} FROM upload_sessions WHERE public_id=?${lock ? " FOR UPDATE" : ""}`;
}

function uploadColumns() {
  return `SELECT CAST(id AS CHAR) AS id, public_id AS publicId,
      CAST(family_id AS CHAR) AS familyId,
      CAST(created_by_member_id AS CHAR) AS createdByMemberId,
      CAST(declared_size AS CHAR) AS declaredSize,
      CAST(committed_offset AS CHAR) AS committedOffset,
      state, expires_at AS expiresAt, created_at AS createdAt,
      updated_at AS updatedAt,
      completed_at AS completedAt,
      computed_sha256 AS computedSha256,
      finalize_started_at AS finalizeStartedAt,
      CAST(storage_object_id AS CHAR) AS storageObjectId,
      failure_code AS failureCode,
      staging_cleaned_at AS stagingCleanedAt,
      terminal_at AS terminalAt`;
}

function objectSelect(lock: boolean) {
  return `SELECT CAST(id AS CHAR) AS id, sha256,
      CAST(byte_size AS CHAR) AS byteSize, key_version AS keyVersion, state
    FROM storage_objects WHERE family_id=? AND sha256=? AND byte_size=?
    LIMIT 1${lock ? " FOR UPDATE" : ""}`;
}

function mapObject(row: ObjectRow): StorageObjectRecord {
  if (!Buffer.isBuffer(row.sha256) || row.sha256.length !== 32) {
    throw new Error("STORAGE_OBJECT_HASH_CORRUPT");
  }
  return {
    id: String(row.id),
    sha256: row.sha256,
    byteSize: BigInt(row.byteSize),
    keyVersion: Number(row.keyVersion),
    state: row.state,
  };
}

function mapUpload(row: UploadRow): UploadRecord {
  const failureCode = row.failureCode;
  if (
    failureCode !== null &&
    !uploadFailureCodes.includes(failureCode as UploadFailureCode)
  ) {
    throw new Error("UPLOAD_FAILURE_CODE_CORRUPT");
  }
  return {
    id: String(row.id),
    publicId: row.publicId.toString("hex"),
    familyId: String(row.familyId),
    createdByMemberId: String(row.createdByMemberId),
    declaredSize: BigInt(row.declaredSize),
    committedOffset: BigInt(row.committedOffset),
    state: row.state,
    expiresAt: row.expiresAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    completedAt: row.completedAt,
    computedSha256: row.computedSha256,
    finalizeStartedAt: row.finalizeStartedAt,
    storageObjectId:
      row.storageObjectId === null ? null : String(row.storageObjectId),
    failureCode: failureCode as UploadFailureCode | null,
    stagingCleanedAt: row.stagingCleanedAt,
    terminalAt: row.terminalAt,
  };
}

function assertScanLimit(afterId: string, limit: number) {
  if (
    !/^(?:0|[1-9][0-9]*)$/u.test(afterId) ||
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > 256
  ) {
    throw new TypeError("RECOVERY_SCAN_LIMIT_INVALID");
  }
}

export function createUploadPublicId() {
  return randomBytes(16);
}
