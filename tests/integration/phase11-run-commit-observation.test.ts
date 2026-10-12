import { describe, expect, it } from "vitest";
import {
  createDatabase,
  MySqlSystemRunRepository,
  type Pool,
  type RowDataPacket,
} from "../../packages/db/src/index.js";
import { InProcessControlOwner } from "../helpers/in-process-control-owner.js";

if (!process.env.DATABASE_URL) throw Error("PHASE11_DEV_DB_REQUIRED");

/** The actual server commits once. Only the response to that precise record
 * transaction is lost; observations use a fresh checked SQL connection. */
function loseRecordCommit(pool: Pool, mutation: string) {
  let matchingCommits = 0,
    lostReplies = 0,
    destroys = 0;
  const wrapped = new Proxy(pool, {
    get(target, key) {
      if (key === "getConnection")
        return async () => {
          const connection = await target.getConnection();
          let matched = false;
          return new Proxy(connection, {
            get(c, property) {
              if (property === "query")
                return async (...args: unknown[]) => {
                  const statement = args[0];
                  const sql =
                    typeof statement === "string"
                      ? statement
                      : statement &&
                          typeof statement === "object" &&
                          "sql" in statement
                        ? String(statement.sql)
                        : "";
                  if (sql.includes(mutation)) matched = true;
                  return Reflect.apply(c.query, c, args);
                };
              if (property === "commit")
                return async () => {
                  await c.commit();
                  if (matched) {
                    matchingCommits++;
                    if (lostReplies === 0) {
                      lostReplies++;
                      throw Error("SYNTHETIC_RUN_RECORD_COMMIT_REPLY_LOST");
                    }
                  }
                  matched = false;
                };
              if (property === "destroy")
                return () => {
                  destroys++;
                  c.destroy();
                };
              const value = Reflect.get(c, property);
              return typeof value === "function" ? value.bind(c) : value;
            },
          });
        };
      const value = Reflect.get(target, key);
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as Pool;
  return {
    repository: new MySqlSystemRunRepository(wrapped),
    counts: () => ({ matchingCommits, lostReplies, destroys }),
  };
}

describe.sequential("R1 real MySQL run record commit observation", () => {
  it.each([
    "INSERT INTO system_control_runs(",
    "UPDATE system_control_runs SET phase='STOPPING'",
    "UPDATE system_control_run_members SET state='CLEAN_CLOSED'",
    "UPDATE system_control_runs SET phase='CLEAN'",
  ])(
    "observes %s by exact identity without replay",
    async (mutation) => {
      const db = createDatabase(process.env.DATABASE_URL!);
      const fault = loseRecordCommit(db.pool, mutation);
      let owner: InProcessControlOwner | undefined;
      try {
        owner = await InProcessControlOwner.start(
          db.pool,
          [],
          undefined,
          {},
          undefined,
          undefined,
          fault.repository,
        );
        const run = await fault.repository.observeCurrent();
        expect(run?.phase).toBe("ACTIVE");
        await owner.fixture.request("READ_ONLY");
        await owner.releaseForApiRestart();
        const clean = await fault.repository.observeCurrent();
        expect(clean?.id).toBe(run?.id);
        expect(clean?.phase).toBe("CLEAN");
        expect(fault.counts()).toEqual({
          matchingCommits: 1,
          lostReplies: 1,
          destroys: 1,
        });
        const [events] = await db.pool.query<RowDataPacket[]>(
          "SELECT action,COUNT(*) n FROM admin_audit_events WHERE scope='SYSTEM' AND operation_id IN (?,?) GROUP BY action",
          [clean!.startup_operation_id, clean!.shutdown_operation_id],
        );
        expect(events.map((r) => [r.action, String(r.n)]).sort()).toEqual([
          ["RUN_CLEAN_CLOSED", "1"],
          ["RUN_STARTED", "1"],
          ["RUN_STOPPING", "1"],
        ]);
      } finally {
        if (owner) {
          if (owner.owner.resources.isAvailable())
            await owner.close({ recheck: true });
          else await owner.cleanupReleasedOwner();
        }
        await db.pool.end();
      }
    },
    60000,
  );
});
