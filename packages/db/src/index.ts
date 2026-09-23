import { drizzle } from "drizzle-orm/mysql2";
import mysql from "mysql2/promise";
export { validateDatabaseHealth } from "./health.js";
export * from "./connection.js";
export * from "./auth-repository.js";
export * from "./bootstrap.js";
export * from "./migration-readiness.js";
export * from "./phase1c-repository.js";
export * from "./album-repository.js";
export * from "./transaction.js";
export * from "./upload-repository.js";
export * from "./media-repository.js";
export * from "./job-repository.js";
export * from "./metadata-repository.js";
export * from "./derived-admission-repository.js";
export {
  MySqlDerivedAssetFence,
  derivativeFailureDisposition,
  type DerivedFenceOutcome,
  type DerivedFenceView,
  type DerivedPublishingPayload,
} from "./derived-asset-fence.js";
export {
  correlateDerivedFilesystemInventory,
  type CorrelatedDerivedTemp,
  type DerivedFilesystemObservation,
} from "./capacity-inventory.js";
export {
  classifyDerivedRecoveryCase,
  reconcileDerivedPublishRecovery,
  type DerivedRecoveryAction,
  type DerivedRecoveryDecision,
  type DerivedRecoveryFinalFact,
  type DerivedRecoveryRow,
  type DerivedRecoveryTempFact,
} from "./derived-recovery.js";

export const databaseConnectionDefaults = Object.freeze({
  connectionLimit: 5,
  enableKeepAlive: true,
  multipleStatements: false,
  supportBigNumbers: true,
  bigNumberStrings: true,
  timezone: "Z",
});

export function createDatabase(databaseUrl: string) {
  const pool = mysql.createPool({
    uri: databaseUrl,
    ...databaseConnectionDefaults,
  });

  return {
    db: drizzle({ client: pool }),
    pool,
  };
}
