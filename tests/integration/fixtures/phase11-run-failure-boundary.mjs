import process from "node:process";
import { writeFileSync } from "node:fs";
import { MySqlSystemRunRepository } from "../../../packages/db/dist/index.js";
import { StorageRoot } from "../../../packages/storage/src/index.ts";

const stage = process.env.PHASE11_RUN_FAILURE_BOUNDARY;
const evidence = process.env.PHASE11_RUN_FAILURE_EVIDENCE;
if (
  process.env.APP_ENV !== "dev" ||
  !["PREPARING", "STOPPING", "CLOSE_FAILURE", "CLEAN_AUDIT_FAILURE"].includes(
    stage,
  ) ||
  !evidence
)
  throw Error("RUN_FAILURE_DEV_FIXTURE_REQUIRED");
const save = () =>
  writeFileSync(evidence, JSON.stringify({ stage, boundaryReached: true }), {
    mode: 0o600,
  });
if (stage === "PREPARING" || stage === "STOPPING") {
  const method = stage === "PREPARING" ? "activateAutomatic" : "acknowledge";
  MySqlSystemRunRepository.prototype[method] = async function () {
    save();
    // Exact test-owned process is intentionally crashed at this uncommitted
    // boundary. No terminal proof, replacement heartbeat or synthetic CLEAN.
    await new Promise(() => {});
  };
} else if (stage === "CLOSE_FAILURE") {
  let armed = false,
    failed = false;
  const stopping = MySqlSystemRunRepository.prototype.stopping;
  MySqlSystemRunRepository.prototype.stopping = async function (...args) {
    const result = await stopping.apply(this, args);
    armed = true;
    return result;
  };
  const close = StorageRoot.prototype.close;
  StorageRoot.prototype.close = function () {
    const result = close.call(this);
    if (armed && !failed) {
      failed = true;
      save();
      throw Error("SYNTHETIC_OWNER_CLOSE_FAILURE");
    }
    return result;
  };
} else {
  const clean = MySqlSystemRunRepository.prototype.clean;
  MySqlSystemRunRepository.prototype.clean = async function (...args) {
    const wrapped = new Proxy(this.pool, {
      get(target, key) {
        if (key === "getConnection")
          return async () => {
            const c = await target.getConnection();
            return new Proxy(c, {
              get(connection, property) {
                if (property === "execute")
                  return async (...queryArgs) => {
                    const sql = queryArgs[0];
                    if (
                      typeof sql === "string" &&
                      sql.includes("INSERT INTO admin_audit_events")
                    ) {
                      save();
                      throw Error("SYNTHETIC_RUN_CLEAN_AUDIT_FAILURE");
                    }
                    return Reflect.apply(
                      connection.execute,
                      connection,
                      queryArgs,
                    );
                  };
                const value = Reflect.get(connection, property);
                return typeof value === "function"
                  ? value.bind(connection)
                  : value;
              },
            });
          };
        const value = Reflect.get(target, key);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    return clean.apply(new MySqlSystemRunRepository(wrapped), args);
  };
}
