import { performance } from "node:perf_hooks";

import type { Pool, PoolConnection, RowDataPacket } from "mysql2/promise";

import { acquireCheckedConnection } from "./connection.js";
import {
  CommitOutcomeUnknownError,
  runTransaction,
  TransactionRollbackFailedError,
} from "./transaction.js";

const CAPACITY_DATABASE = "family_album_dev";
const CAPACITY_LOCK_NAME = `${CAPACITY_DATABASE}.capacity.v1`;
export const CAPACITY_OUTCOME_RESOLUTION_MS = 5_000;

export class CapacityDeadlineError extends Error {
  constructor() {
    super("Capacity admission deadline exceeded.");
    this.name = "CapacityDeadlineError";
  }
}

export class CapacityCoordinationError extends Error {
  constructor() {
    super("Capacity coordination is unavailable.");
    this.name = "CapacityCoordinationError";
  }
}

export type CapacityTransactionOutcome<T> =
  | { transaction: "COMMITTED"; value: T; deadlineExceeded: boolean }
  | { transaction: "NOT_STARTED"; error: unknown }
  | { transaction: "ROLLED_BACK"; error: unknown }
  | { transaction: "UNKNOWN" };

/**
 * The session lock and SQL transaction always use one checked physical
 * connection. The caller must already own the root-local capacity lock.
 * No filesystem mutation is permitted in operation or beforeCommit.
 */
export async function runCapacityTransaction<T>(
  pool: Pool,
  admissionDeadline: number,
  operation: (connection: PoolConnection) => Promise<T>,
  options: {
    beforeCommit?: (connection: PoolConnection) => void | Promise<void>;
    /** DB-boundary fault seam; production always uses connection.commit(). */
    commitForTest?: (connection: PoolConnection) => Promise<void>;
    /** DB-boundary fault seam; production always uses connection.rollback(). */
    rollbackForTest?: (connection: PoolConnection) => Promise<void>;
  } = {},
): Promise<CapacityTransactionOutcome<T>> {
  if (!Number.isFinite(admissionDeadline)) {
    throw new CapacityCoordinationError();
  }
  const controller = new AbortController();
  let activeConnection: PoolConnection | null = null;
  let operationEntered = false;
  const settleDeadline = admissionDeadline + CAPACITY_OUTCOME_RESOLUTION_MS;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<CapacityTransactionOutcome<T>>((resolve) => {
    timeout = setTimeout(
      () => {
        controller.abort();
        activeConnection?.destroy();
        resolve({ transaction: "UNKNOWN" });
      },
      Math.max(0, settleDeadline - performance.now()),
    );
  });
  const work = runTransaction(
    pool,
    async (connection) => {
      operationEntered = true;
      return operation(connection);
    },
    {
      signal: controller.signal,
      acquire: async () => {
        operationEntered = false;
        const connection = await acquireCheckedConnection(pool);
        activeConnection = connection;
        try {
          controller.signal.throwIfAborted();
          const remaining = admissionDeadline - performance.now();
          if (remaining <= 0) throw new CapacityDeadlineError();
          const [identityRows] = await connection.query<RowDataPacket[]>(
            "SELECT DATABASE() AS databaseName, CONNECTION_ID() AS connectionId",
          );
          if (identityRows[0]?.databaseName !== CAPACITY_DATABASE) {
            throw new CapacityCoordinationError();
          }
          const [lockRows] = await connection.query<RowDataPacket[]>(
            "SELECT GET_LOCK(?, ?) AS acquired",
            [CAPACITY_LOCK_NAME, Math.max(0, remaining / 1_000)],
          );
          if (String(lockRows[0]?.acquired) !== "1") {
            throw new CapacityCoordinationError();
          }
          controller.signal.throwIfAborted();
          if (performance.now() >= admissionDeadline) {
            throw new CapacityDeadlineError();
          }
          return connection;
        } catch (error) {
          connection.destroy();
          activeConnection = null;
          throw error;
        }
      },
      release: async (connection) => {
        try {
          const [rows] = await connection.query<RowDataPacket[]>(
            "SELECT RELEASE_LOCK(?) AS released",
            [CAPACITY_LOCK_NAME],
          );
          if (String(rows[0]?.released) !== "1") {
            throw new CapacityCoordinationError();
          }
          connection.release();
        } catch {
          connection.destroy();
          throw new CapacityCoordinationError();
        } finally {
          activeConnection = null;
        }
      },
      destroy: (connection) => {
        connection.destroy();
        activeConnection = null;
      },
      beforeCommit: async (connection) => {
        controller.signal.throwIfAborted();
        if (performance.now() >= admissionDeadline) {
          throw new CapacityDeadlineError();
        }
        await options.beforeCommit?.(connection);
        controller.signal.throwIfAborted();
        if (performance.now() >= admissionDeadline) {
          throw new CapacityDeadlineError();
        }
      },
      ...(options.commitForTest ? { commit: options.commitForTest } : {}),
      ...(options.rollbackForTest ? { rollback: options.rollbackForTest } : {}),
    },
  ).then(
    (value): CapacityTransactionOutcome<T> => ({
      transaction: "COMMITTED",
      value,
      deadlineExceeded: performance.now() >= admissionDeadline,
    }),
    (error): CapacityTransactionOutcome<T> => {
      if (
        error instanceof CommitOutcomeUnknownError ||
        error instanceof TransactionRollbackFailedError ||
        error instanceof CapacityCoordinationError ||
        controller.signal.aborted
      ) {
        return { transaction: "UNKNOWN" };
      }
      return operationEntered
        ? { transaction: "ROLLED_BACK", error }
        : { transaction: "NOT_STARTED", error };
    },
  );
  try {
    return await Promise.race([work, timedOut]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

/**
 * An ambiguous COMMIT may only be read back after acquiring the same named
 * session barrier on a fresh checked connection. A timeout leaves it unknown.
 */
export async function readCapacityOutcome<T>(
  pool: Pool,
  deadline: number,
  read: (connection: PoolConnection) => Promise<T>,
): Promise<T | null> {
  if (!Number.isFinite(deadline) || performance.now() >= deadline) return null;
  let connection: PoolConnection | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let cancelled = false;
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(
      () => {
        cancelled = true;
        connection?.destroy();
        resolve(null);
      },
      Math.max(0, deadline - performance.now()),
    );
  });
  const attempt = (async () => {
    connection = await acquireCheckedConnection(pool);
    try {
      if (cancelled) return null;
      const [identity] = await connection.query<RowDataPacket[]>(
        "SELECT DATABASE() AS databaseName",
      );
      if (identity[0]?.databaseName !== CAPACITY_DATABASE) return null;
      const remaining = deadline - performance.now();
      if (remaining <= 0) return null;
      const [lock] = await connection.query<RowDataPacket[]>(
        "SELECT GET_LOCK(?, ?) AS acquired",
        [CAPACITY_LOCK_NAME, remaining / 1_000],
      );
      if (cancelled || String(lock[0]?.acquired) !== "1") return null;
      await connection.beginTransaction();
      const result = await read(connection);
      await connection.rollback();
      if (cancelled) return null;
      const [released] = await connection.query<RowDataPacket[]>(
        "SELECT RELEASE_LOCK(?) AS released",
        [CAPACITY_LOCK_NAME],
      );
      if (String(released[0]?.released) !== "1") return null;
      connection.release();
      connection = null;
      return result;
    } catch {
      return null;
    } finally {
      connection?.destroy();
    }
  })();
  try {
    return await Promise.race([attempt, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
