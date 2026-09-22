import type { Pool, PoolConnection } from "mysql2/promise";

export class CommitOutcomeUnknownError extends Error {
  readonly errorCategory = "COMMIT_OUTCOME_UNKNOWN";

  constructor() {
    super("Transaction commit outcome is unknown.");
    this.name = "CommitOutcomeUnknownError";
  }
}

export class TransactionRollbackFailedError extends Error {
  readonly errorCategory = "ROLLBACK_FAILED";

  constructor() {
    super("Transaction rollback failed.");
    this.name = "TransactionRollbackFailedError";
  }
}

export type TransactionOptions = {
  acquire?: () => Promise<PoolConnection>;
  release?: (connection: PoolConnection) => void | Promise<void>;
  destroy?: (connection: PoolConnection) => void | Promise<void>;
  random?: () => number;
  sleep?: (milliseconds: number) => Promise<void>;
  /** Optional admission fence; a rejection here is still pre-COMMIT. */
  beforeCommit?: (connection: PoolConnection) => void | Promise<void>;
  /** Cancellation is checked before every new SQL phase and retry. */
  signal?: AbortSignal;
  /** Explicit DB-boundary fault seam; production uses connection.commit(). */
  commit?: (connection: PoolConnection) => Promise<void>;
  /** Explicit DB-boundary rollback fault seam; production uses rollback(). */
  rollback?: (connection: PoolConnection) => Promise<void>;
};

const DEADLOCK_RETRY_RANGES = [
  [10, 50],
  [25, 100],
] as const;

export async function runTransaction<T>(
  pool: Pool,
  operation: (connection: PoolConnection) => Promise<T>,
  options: TransactionOptions = {},
): Promise<T> {
  const acquire = options.acquire ?? (() => pool.getConnection());
  const release = options.release ?? ((connection) => connection.release());
  const destroy = options.destroy ?? ((connection) => connection.destroy());
  const random = options.random ?? Math.random;
  const sleep =
    options.sleep ??
    ((milliseconds: number) =>
      new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));

  for (let attempt = 0; attempt < 3; attempt += 1) {
    options.signal?.throwIfAborted();
    const connection = await acquire();
    let transactionStarted = false;
    let phase: "BEGIN" | "OPERATION" | "COMMIT" = "BEGIN";
    try {
      options.signal?.throwIfAborted();
      await connection.beginTransaction();
      transactionStarted = true;
      phase = "OPERATION";
      options.signal?.throwIfAborted();
      const value = await operation(connection);
      options.signal?.throwIfAborted();
      await options.beforeCommit?.(connection);
      options.signal?.throwIfAborted();
      phase = "COMMIT";
      await (options.commit?.(connection) ?? connection.commit());
      transactionStarted = false;
      await release(connection);
      return value;
    } catch (error) {
      if (phase === "COMMIT") {
        await destroy(connection);
        throw new CommitOutcomeUnknownError();
      }

      if (transactionStarted) {
        try {
          await (options.rollback?.(connection) ?? connection.rollback());
          transactionStarted = false;
        } catch {
          await destroy(connection);
          throw new TransactionRollbackFailedError();
        }
      }

      if (isConnectionStateUncertain(error)) await destroy(connection);
      else await release(connection);

      if (!options.signal?.aborted && isDeadlock(error) && attempt < 2) {
        const [minimum, maximum] = DEADLOCK_RETRY_RANGES[attempt]!;
        const jitter = Math.floor(minimum + random() * (maximum - minimum + 1));
        await sleep(jitter);
        continue;
      }
      throw error;
    }
  }

  throw new Error("Unreachable transaction retry state.");
}

export function isDeadlock(error: unknown) {
  const mysqlError = asMySqlError(error);
  return (
    mysqlError?.code === "ER_LOCK_DEADLOCK" &&
    (mysqlError.errno === undefined || mysqlError.errno === 1213) &&
    (mysqlError.sqlState === undefined || mysqlError.sqlState === "40001")
  );
}

export function isLockWaitTimeout(error: unknown) {
  const mysqlError = asMySqlError(error);
  return (
    mysqlError?.code === "ER_LOCK_WAIT_TIMEOUT" || mysqlError?.errno === 1205
  );
}

function isConnectionStateUncertain(error: unknown) {
  const mysqlError = asMySqlError(error);
  if (!mysqlError) return false;
  return (
    mysqlError.fatal === true ||
    mysqlError.code?.startsWith("PROTOCOL_") === true ||
    mysqlError.code?.startsWith("ECONN") === true ||
    mysqlError.code === "EPIPE" ||
    mysqlError.code === "ETIMEDOUT"
  );
}

function asMySqlError(error: unknown) {
  if (!error || typeof error !== "object") return null;
  return error as {
    code?: string;
    errno?: number;
    sqlState?: string;
    fatal?: boolean;
  };
}
