import type { Pool, PoolConnection } from "mysql2/promise";
import { checkDatabaseConnection } from "./connection.js";

/** Observation only. Never wrap a mutation/COMMIT or an admitted FS unit with
 * this deadline. Late checked acquisition is discarded before invoking read. */
export async function boundedCheckedRead<T>(
  pool: Pool,
  read: (c: PoolConnection, discard: () => void) => Promise<T>,
  budgetMs = 2000,
): Promise<T> {
  if (!Number.isFinite(budgetMs) || budgetMs <= 0 || budgetMs > 2000)
    throw new Error("READINESS_BUDGET_INVALID");
  let connection: PoolConnection | undefined,
    expired = false,
    discarded = false;
  const discard = () => {
    if (connection && !discarded) {
      discarded = true;
      connection.destroy();
    }
  };
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      expired = true;
      discard();
      reject(new Error("READINESS_UNAVAILABLE"));
    }, budgetMs);
  });
  const work = (async () => {
    const c = await pool.getConnection();
    connection = c;
    try {
      if (expired) {
        discard();
        throw new Error("READINESS_UNAVAILABLE");
      }
      await checkDatabaseConnection(c);
      if (expired) throw new Error("READINESS_UNAVAILABLE");
      return await read(c, discard);
    } finally {
      if (!expired && !discarded) c.release();
    }
  })();
  try {
    return await Promise.race([work, deadline]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
