import process from "node:process";
import { writeFileSync } from "node:fs";
import { MySqlSystemRunRepository } from "../../../packages/db/dist/index.js";

const stages = {
  BEGIN: ["begin", "INSERT INTO system_control_runs("],
  AUTO_ACTIVE: [
    "activateAutomatic",
    "UPDATE system_control_runs SET phase='ACTIVE'",
  ],
  STOPPING: ["stopping", "UPDATE system_control_runs SET phase='STOPPING'"],
  ACK: [
    "acknowledge",
    "UPDATE system_control_run_members SET state='CLEAN_CLOSED'",
  ],
  CLEAN: ["clean", "UPDATE system_control_runs SET phase='CLEAN'"],
};
const stage = process.env.PHASE11_RUN_RECORD_LOSS;
const selected = stages[stage];
const evidence = process.env.PHASE11_RUN_RECORD_EVIDENCE;
if (process.env.APP_ENV !== "dev" || !selected || !evidence)
  throw Error("RUN_RECORD_LOSS_DEV_FIXTURE_REQUIRED");
const [method, mutation] = selected;
let matchingCommits = 0,
  lostReplies = 0,
  destroys = 0,
  returned = 0;
function save() {
  writeFileSync(
    evidence,
    JSON.stringify({ stage, matchingCommits, lostReplies, destroys, returned }),
    { mode: 0o600 },
  );
}
const original = MySqlSystemRunRepository.prototype[method];
MySqlSystemRunRepository.prototype[method] = async function (...args) {
  const wrapped = new Proxy(this.pool, {
    get(target, key) {
      if (key === "getConnection")
        return async () => {
          const connection = await target.getConnection();
          let matched = false;
          return new Proxy(connection, {
            get(c, property) {
              if (property === "query" || property === "execute")
                return async (...queryArgs) => {
                  const statement = queryArgs[0];
                  const sql =
                    typeof statement === "string"
                      ? statement
                      : String(statement?.sql ?? "");
                  if (sql.includes(mutation)) matched = true;
                  return Reflect.apply(c[property], c, queryArgs);
                };
              if (property === "commit")
                return async () => {
                  await c.commit();
                  if (matched) {
                    matchingCommits++;
                    if (lostReplies === 0) {
                      lostReplies++;
                      save();
                      throw Error("SYNTHETIC_BUILT_RUN_COMMIT_REPLY_LOST");
                    }
                  }
                  matched = false;
                };
              if (property === "destroy")
                return () => {
                  destroys++;
                  save();
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
  });
  const result = await original.apply(
    new MySqlSystemRunRepository(wrapped),
    args,
  );
  returned++;
  save();
  return result;
};
