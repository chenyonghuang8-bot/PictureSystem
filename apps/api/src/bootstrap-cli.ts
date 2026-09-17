import {
  createPasswordEngine,
  normalizeUsername,
  validatePassword,
} from "@family-album/auth";
import { loadApiEnv, parseDatabaseUrl } from "@family-album/config";
import {
  bootstrapIdentity,
  BootstrapRejectedError,
  CommitOutcomeUnknownError,
  createDatabase,
} from "@family-album/db";

import {
  assertInteractiveDevRuntime,
  validateBootstrapDisplayName,
  validateFamilyName,
} from "./bootstrap/input.js";
import { readHiddenLine, readVisibleLine } from "./bootstrap/tty.js";

const operationId = crypto.randomUUID();

async function main() {
  try {
    assertInteractiveDevRuntime({
      argvLength: process.argv.length,
      appEnv: process.env.APP_ENV,
      nodeEnv: process.env.NODE_ENV,
      stdinIsTty: process.stdin.isTTY,
      stdoutIsTty: process.stdout.isTTY,
    });
  } catch {
    throw new BootstrapRejectedError("LOCAL_INTERACTIVE_DEV_ONLY");
  }
  const env = loadApiEnv();
  const databaseUrl = parseDatabaseUrl(env.DATABASE_URL);
  if (!isLoopback(databaseUrl.hostname)) {
    throw new BootstrapRejectedError("LOCAL_DATABASE_REQUIRED");
  }

  const familyName = validateFamilyName(await readVisibleLine("Family name: "));
  const normalized = normalizeUsername(await readVisibleLine("Username: "));
  const displayName = validateBootstrapDisplayName(
    await readVisibleLine("Display name (optional): "),
  );
  const firstPassword = validatePassword(await readHiddenLine("Password: "));
  const confirmation = validatePassword(
    await readHiddenLine("Confirm password: "),
  );
  if (firstPassword !== confirmation) {
    throw new BootstrapRejectedError("PASSWORD_CONFIRMATION_MISMATCH");
  }

  const passwords = createPasswordEngine();
  const passwordHash = await passwords.hash(firstPassword);
  const database = createDatabase(env.DATABASE_URL);
  try {
    const result = await bootstrapIdentity(database.pool, {
      familyName,
      username: normalized.display,
      usernameNormalized: normalized.normalizedBytes,
      passwordHash,
      displayName,
    });
    console.info(
      JSON.stringify({
        event: "bootstrap_completed",
        operationId,
        resultCode: "SUCCESS",
        familyId: result.familyId,
        userId: result.userId,
        memberId: result.memberId,
        cleanupWarning: result.cleanupWarning,
      }),
    );
  } finally {
    await database.pool.end();
  }
}

function isLoopback(hostname: string) {
  return (
    hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]"
  );
}

try {
  await main();
} catch (error) {
  const errorCategory =
    error instanceof CommitOutcomeUnknownError
      ? "COMMIT_OUTCOME_UNKNOWN"
      : error instanceof BootstrapRejectedError
        ? error.reason
        : "BOOTSTRAP_FAILURE";
  console.error(
    JSON.stringify({
      event: "bootstrap_rejected",
      operationId,
      resultCode: "REJECTED",
      errorCategory,
    }),
  );
  process.exitCode = 1;
}
