import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, isAbsolute, normalize, sep } from "node:path";
import {
  createDatabase,
  acquireCheckedConnection,
  assertMigrationReadiness,
  MySqlSystemControlRepository,
} from "@family-album/db";
import {
  adminOperationIdSchema,
  adminRevisionSchema,
} from "../../../packages/contracts/src/admin.js";
import { OperationGate } from "@family-album/storage";
import { loadApiEnv } from "@family-album/config";

/** Trusted local DEV maintenance only. No public endpoint routes into this CLI;
 * bootstrap records a pending protected command and never grants NORMAL. */
async function main() {
  const args = process.argv.slice(2),
    kind = args.shift();
  const flags = new Map<string, string | true>();
  while (args.length) {
    const key = args.shift()!;
    if (
      ![
        "--operation-id",
        "--family-id",
        "--user-id",
        "--ack-dev-control",
        "--ack-system-scope",
        "--revoke",
      ].includes(key) ||
      flags.has(key)
    )
      throw Error("CONTROL_ARGUMENT_INVALID");
    if (["--ack-dev-control", "--ack-system-scope", "--revoke"].includes(key))
      flags.set(key, true);
    else {
      const value = args.shift();
      if (!value || value.startsWith("--"))
        throw Error("CONTROL_ARGUMENT_INVALID");
      flags.set(key, value);
    }
  }
  if (kind !== "bootstrap" && kind !== "grant")
    throw Error("CONTROL_COMMAND_REQUIRED");
  const operationId = adminOperationIdSchema.parse(flags.get("--operation-id"));
  if (
    kind === "bootstrap" &&
    (flags.get("--ack-dev-control") !== true ||
      [...flags.keys()].some(
        (key) => !["--ack-dev-control", "--operation-id"].includes(key),
      ))
  )
    throw Error("CONTROL_ACK_REQUIRED");
  if (
    kind === "grant" &&
    (flags.get("--ack-system-scope") !== true || flags.has("--ack-dev-control"))
  )
    throw Error("SYSTEM_SCOPE_ACK_REQUIRED");
  process.loadEnvFile(resolve(import.meta.dirname, "../../../.env"));
  const env = loadApiEnv(),
    url = env.DATABASE_URL;
  const target = new URL(url);
  if (
    env.APP_ENV !== "dev" ||
    target.protocol !== "mysql:" ||
    target.pathname !== "/family_album_dev" ||
    !["localhost", "127.0.0.1", "[::1]"].includes(target.hostname) ||
    decodeURIComponent(target.username).toLowerCase() === "root"
  )
    throw Error("CONTROL_DEV_CONFIG_REQUIRED");
  const database = createDatabase(url),
    repository = new MySqlSystemControlRepository(database.pool);
  try {
    const c = await acquireCheckedConnection(database.pool);
    try {
      await assertMigrationReadiness(c);
    } finally {
      c.release();
    }
    if (kind === "grant") {
      const familyId = adminRevisionSchema.parse(flags.get("--family-id")),
        userId = adminRevisionSchema.parse(flags.get("--user-id"));
      await repository.localGrant({
        familyId,
        userId,
        enabled: !flags.has("--revoke"),
        operationId,
      });
      console.log(
        JSON.stringify({
          event: "PHASE11_SYSTEM_GRANT_RECORDED",
          operationId,
          enabled: !flags.has("--revoke"),
        }),
      );
      return;
    }
    const path = process.env.DEV_CONTROL_PATH,
      deploymentId = adminOperationIdSchema.parse(
        process.env.DEV_CONTROL_DEPLOYMENT_ID,
      );
    if (!path || !isAbsolute(path) || normalize(path) !== path)
      throw Error("CONTROL_NAMESPACE_CONFIG_REQUIRED");
    const permitted = [
      realpathSync(tmpdir()) + sep,
      realpathSync("/tmp") + sep,
      realpathSync(resolve(import.meta.dirname, "../../..")) +
        sep +
        ".cache" +
        sep,
    ];
    if (!permitted.some((prefix) => path.startsWith(prefix)))
      throw Error("CONTROL_DEV_PATH_REQUIRED");
    const gate = OperationGate.provisionDev({ path, deploymentId });
    const s = await gate.acquire("S");
    let namespaceIdentity: string;
    try {
      namespaceIdentity = s.identity();
    } finally {
      s.close();
    }
    const operation = await repository.bootstrap({
      operationId,
      deploymentId,
      namespaceIdentity,
    });
    console.log(
      JSON.stringify({
        event: "PHASE11_BOOTSTRAP_OBSERVED",
        operationId,
        status: operation.status,
        targetMode: operation.targetMode,
        reasonCode: operation.reasonCode,
      }),
    );
  } finally {
    await database.pool.end();
  }
}
void main().catch(() => {
  // Includes unknown COMMIT. Do not print raw credentials/errors or replay.
  console.error(
    "PHASE11_LOCAL_CONTROL_UNCONFIRMED_OBSERVE_OPERATION_NO_REPLAY",
  );
  process.exitCode = 1;
});
