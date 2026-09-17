import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/mysql2";
import mysql from "mysql2/promise";
import type {
  PoolConnection,
  ResultSetHeader,
  RowDataPacket,
} from "mysql2/promise";

import { validateDatabaseHealth } from "../src/health.js";
import { assertMigrationReadiness } from "../src/migration-readiness.js";
import { storageObjects, uploadSessions } from "../src/schema.js";

interface IdentityRow extends RowDataPacket {
  databaseName: string | null;
  currentUser: string;
  version: string;
}
interface TableRow extends RowDataPacket {
  tableName: string;
  engine: string;
  collation: string;
}
interface NameRow extends RowDataPacket {
  name: string;
}
interface IndexRow extends RowDataPacket {
  tableName: string;
  name: string;
}
interface IdRow extends RowDataPacket {
  id: string;
}
interface BigIntRow extends RowDataPacket {
  byteSize: string;
  declaredSize: string;
  committedOffset: string;
}
interface CountRow extends RowDataPacket {
  count: string;
}

const packageDirectory = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const rootEnvFile = resolve(packageDirectory, "../..", ".env");
if (!process.env.DATABASE_URL && existsSync(rootEnvFile)) {
  process.loadEnvFile(rootEnvFile);
}
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required");
const parsedDatabaseUrl = new URL(databaseUrl);
if (
  parsedDatabaseUrl.protocol !== "mysql:" ||
  parsedDatabaseUrl.pathname !== "/family_album_dev"
) {
  throw new Error("Phase 3 verification is restricted to family_album_dev");
}
if (decodeURIComponent(parsedDatabaseUrl.username).toLowerCase() === "root") {
  throw new Error("Phase 3 verification refuses the MySQL root account");
}

const expectedIndexes = [
  "storage_objects.idx_storage_objects_state_verified",
  "storage_objects.PRIMARY",
  "storage_objects.uq_storage_objects_family_hash_size",
  "storage_objects.uq_storage_objects_family_id",
  "upload_sessions.idx_upload_sessions_cleanup",
  "upload_sessions.idx_upload_sessions_family_creator_state",
  "upload_sessions.idx_upload_sessions_family_object",
  "upload_sessions.idx_upload_sessions_state_expiry",
  "upload_sessions.PRIMARY",
  "upload_sessions.uq_upload_sessions_public_id",
];
const expectedForeignKeys = [
  "fk_storage_objects_family",
  "fk_upload_sessions_creator_member",
  "fk_upload_sessions_family",
  "fk_upload_sessions_storage_object",
];
const expectedChecks = [
  "chk_storage_objects_key_version",
  "chk_storage_objects_size",
  "chk_storage_objects_verified",
  "chk_upload_sessions_complete",
  "chk_upload_sessions_created",
  "chk_upload_sessions_expiry",
  "chk_upload_sessions_failure",
  "chk_upload_sessions_finalize_pair",
  "chk_upload_sessions_finalize_state",
  "chk_upload_sessions_size_offset",
  "chk_upload_sessions_terminal",
  "chk_upload_sessions_times",
  "chk_upload_sessions_uploading",
];

const pool = mysql.createPool({
  uri: databaseUrl,
  connectionLimit: 1,
  multipleStatements: false,
  supportBigNumbers: true,
  bigNumberStrings: true,
  timezone: "Z",
});
const connection = await pool.getConnection();

try {
  const health = await validateDatabaseHealth(connection);
  const [[identity]] = await connection.query<IdentityRow[]>(
    "SELECT DATABASE() AS databaseName, CURRENT_USER() AS currentUser, VERSION() AS version",
  );
  if (
    !identity ||
    identity.databaseName !== "family_album_dev" ||
    identity.version !== "9.7.2" ||
    identity.currentUser.split("@", 1)[0]?.toLowerCase() === "root"
  ) {
    throw new Error("Database identity changed after Phase 3 migration");
  }
  const readiness = await assertMigrationReadiness(connection);
  if (readiness.migrationCount !== 3) {
    throw new Error("Phase 3 migration readiness count mismatch");
  }

  const [tables] = await connection.query<TableRow[]>(
    `SELECT TABLE_NAME AS tableName, ENGINE AS engine,
            TABLE_COLLATION AS collation
       FROM information_schema.tables
      WHERE table_schema = DATABASE()
        AND TABLE_NAME IN ('storage_objects','upload_sessions')
      ORDER BY TABLE_NAME`,
  );
  if (
    tables.map((row) => row.tableName).join() !==
      "storage_objects,upload_sessions" ||
    tables.some(
      (row) =>
        row.engine !== "InnoDB" || row.collation !== "utf8mb4_0900_ai_ci",
    )
  ) {
    throw new Error("Phase 3 table engine/collation mismatch");
  }
  const [indexRows] = await connection.query<IndexRow[]>(
    `SELECT DISTINCT TABLE_NAME AS tableName, INDEX_NAME AS name
       FROM information_schema.statistics
      WHERE table_schema = DATABASE()
        AND TABLE_NAME IN ('storage_objects','upload_sessions')
      ORDER BY TABLE_NAME, INDEX_NAME`,
  );
  const indexes = indexRows.map((row) => `${row.tableName}.${row.name}`);
  if (indexes.join() !== expectedIndexes.join()) {
    throw new Error("Phase 3 index manifest mismatch");
  }
  const [foreignKeyRows] = await connection.query<NameRow[]>(
    `SELECT CONSTRAINT_NAME AS name
       FROM information_schema.referential_constraints
      WHERE constraint_schema = DATABASE()
        AND TABLE_NAME IN ('storage_objects','upload_sessions')
      ORDER BY CONSTRAINT_NAME`,
  );
  const foreignKeys = foreignKeyRows.map((row) => row.name);
  if (foreignKeys.join() !== expectedForeignKeys.join()) {
    throw new Error("Phase 3 foreign-key manifest mismatch");
  }
  const [checkRows] = await connection.query<NameRow[]>(
    `SELECT CONSTRAINT_NAME AS name
       FROM information_schema.table_constraints
      WHERE CONSTRAINT_SCHEMA = DATABASE()
        AND TABLE_NAME IN ('storage_objects','upload_sessions')
        AND CONSTRAINT_TYPE = 'CHECK'
      ORDER BY CONSTRAINT_NAME`,
  );
  const checks = checkRows.map((row) => row.name);
  if (checks.join() !== expectedChecks.join()) {
    throw new Error("Phase 3 CHECK manifest mismatch");
  }

  for (const table of ["storage_objects", "upload_sessions"] as const) {
    const [rows] = await connection.query<RowDataPacket[]>(
      `SHOW CREATE TABLE \`${table}\``,
    );
    const ddl = String(rows[0]?.["Create Table"] ?? "");
    for (const required of [
      "ENGINE=InnoDB",
      "CHARSET=utf8mb4",
      "COLLATE=utf8mb4_0900_ai_ci",
      "bigint unsigned",
      "datetime(3)",
    ]) {
      if (!ddl.includes(required)) {
        throw new Error(`${table} SHOW CREATE is missing ${required}`);
      }
    }
  }

  const suffix = randomUUID().replaceAll("-", "");
  const usernames = [0, 1, 2].map((index) => `p3_verify_${index}_${suffix}`);
  const familyNames = [
    `Phase 3 verification A ${suffix}`,
    `Phase 3 verification B ${suffix}`,
  ];
  const publicIds = Array.from({ length: 20 }, (_, index) =>
    Buffer.alloc(16, index + 1),
  );
  const hash = Buffer.alloc(32, 0x51);
  const big = "9007199254740993";
  const bigger = "9007199254740994";
  let transactionStarted = false;
  let familyA = "";
  let familyB = "";
  let userA = "";
  let userA2 = "";
  let userB = "";
  let memberA = "";
  let memberA2 = "";
  let memberB = "";
  let storageA = "";
  let storageA2 = "";
  let storageB = "";
  let createdUpload = "";
  const rejectionKinds = new Set<number>();

  try {
    await connection.beginTransaction();
    transactionStarted = true;
    familyA = await insertAndReadId(
      connection,
      "INSERT INTO families (name) VALUES (?)",
      [familyNames[0]],
    );
    familyB = await insertAndReadId(
      connection,
      "INSERT INTO families (name) VALUES (?)",
      [familyNames[1]],
    );
    userA = await insertUser(connection, usernames[0]!);
    userA2 = await insertUser(connection, usernames[1]!);
    userB = await insertUser(connection, usernames[2]!);
    memberA = await insertMember(connection, familyA, userA);
    memberA2 = await insertMember(connection, familyA, userA2);
    memberB = await insertMember(connection, familyB, userB);

    storageA = await insertStorage(connection, familyA, hash, big);
    await expectRejection(
      () => insertStorage(connection, familyA, hash, big),
      [1062],
      "uq_storage_objects_family_hash_size",
      rejectionKinds,
    );
    storageA2 = await insertStorage(connection, familyA, hash, bigger);
    storageB = await insertStorage(connection, familyB, hash, big);

    createdUpload = await insertUpload(connection, {
      publicId: publicIds[0]!,
      familyId: familyA,
      memberId: memberA,
      filename: `first-${suffix}.bin`,
      declaredSize: big,
      committedOffset: "0",
      state: "CREATED",
    });
    await expectRejection(
      () =>
        insertUpload(connection, {
          publicId: publicIds[0]!,
          familyId: familyA,
          memberId: memberA,
          filename: `duplicate-${suffix}.bin`,
          declaredSize: "1",
          committedOffset: "0",
          state: "CREATED",
        }),
      [1062],
      "uq_upload_sessions_public_id",
      rejectionKinds,
    );
    await expectRejection(
      () =>
        insertUpload(connection, {
          publicId: publicIds[1]!,
          familyId: familyA,
          memberId: memberB,
          filename: `cross-creator-${suffix}.bin`,
          declaredSize: "1",
          committedOffset: "0",
          state: "CREATED",
        }),
      [1452],
      "fk_upload_sessions_creator_member",
      rejectionKinds,
    );
    await expectRejection(
      () =>
        insertCompleteUpload(connection, {
          publicId: publicIds[2]!,
          familyId: familyA,
          memberId: memberA,
          filename: `cross-object-${suffix}.bin`,
          size: big,
          hash,
          storageObjectId: storageB,
        }),
      [1452],
      "fk_upload_sessions_storage_object",
      rejectionKinds,
    );

    await insertCompleteUpload(connection, {
      publicId: publicIds[3]!,
      familyId: familyA,
      memberId: memberA,
      filename: `receipt-one-${suffix}.bin`,
      size: big,
      hash,
      storageObjectId: storageA,
    });
    await insertCompleteUpload(connection, {
      publicId: publicIds[4]!,
      familyId: familyA,
      memberId: memberA2,
      filename: `receipt-two-${suffix}.bin`,
      size: big,
      hash,
      storageObjectId: storageA,
    });

    await expectInvalidUpload(
      connection,
      publicIds[5]!,
      familyA,
      memberA,
      "zero-size",
      {
        declaredSize: "0",
        committedOffset: "0",
        state: "CREATED",
      },
      [3819],
      rejectionKinds,
    );
    await expectInvalidUpload(
      connection,
      publicIds[6]!,
      familyA,
      memberA,
      "offset-overflow",
      {
        declaredSize: "1",
        committedOffset: "2",
        state: "UPLOADING",
      },
      [3819],
      rejectionKinds,
    );
    await expectInvalidUpload(
      connection,
      publicIds[7]!,
      familyA,
      memberA,
      "negative",
      {
        declaredSize: "-1",
        committedOffset: "0",
        state: "CREATED",
      },
      [1264, 3819],
      rejectionKinds,
    );
    await expectInvalidUpload(
      connection,
      publicIds[8]!,
      familyA,
      memberA,
      "created-offset",
      {
        declaredSize: "2",
        committedOffset: "1",
        state: "CREATED",
      },
      [3819],
      rejectionKinds,
    );
    await expectInvalidUpload(
      connection,
      publicIds[9]!,
      familyA,
      memberA,
      "uploading-zero",
      {
        declaredSize: "1",
        committedOffset: "0",
        state: "UPLOADING",
      },
      [3819],
      rejectionKinds,
    );

    await expectRawRejection(
      connection,
      publicIds[10]!,
      familyA,
      memberA,
      "INSERT INTO upload_sessions (public_id,family_id,created_by_member_id,original_filename,declared_size,committed_offset,state,expires_at) VALUES (?,?,?,'invalid-state',1,0,'INVALID',DATE_ADD(CURRENT_TIMESTAMP(3), INTERVAL 1 DAY))",
      [1265, 1366],
      rejectionKinds,
    );
    await expectRawRejection(
      connection,
      publicIds[11]!,
      familyA,
      memberA,
      "INSERT INTO upload_sessions (public_id,family_id,created_by_member_id,original_filename,declared_size,committed_offset,state,expires_at) VALUES (?,?,?,'finalizing-missing',1,1,'FINALIZING',DATE_ADD(CURRENT_TIMESTAMP(3), INTERVAL 1 DAY))",
      [3819],
      rejectionKinds,
    );
    await expectRawRejection(
      connection,
      publicIds[12]!,
      familyA,
      memberA,
      "INSERT INTO upload_sessions (public_id,family_id,created_by_member_id,original_filename,declared_size,committed_offset,state,computed_sha256,finalize_started_at,expires_at) VALUES (?,?,?,'complete-missing',1,1,'COMPLETE',?,CURRENT_TIMESTAMP(3),DATE_ADD(CURRENT_TIMESTAMP(3), INTERVAL 1 DAY))",
      [3819],
      rejectionKinds,
      [hash],
    );
    await expectRawRejection(
      connection,
      publicIds[13]!,
      familyA,
      memberA,
      "INSERT INTO upload_sessions (public_id,family_id,created_by_member_id,original_filename,declared_size,committed_offset,state,computed_sha256,finalize_started_at,storage_object_id,completed_at,terminal_at,expires_at) VALUES (?,?,?,'complete-terminal',?,?,'COMPLETE',?,CURRENT_TIMESTAMP(3),?,CURRENT_TIMESTAMP(3),CURRENT_TIMESTAMP(3),DATE_ADD(CURRENT_TIMESTAMP(3), INTERVAL 1 DAY))",
      [3819],
      rejectionKinds,
      [big, big, hash, storageA],
    );
    await expectRawRejection(
      connection,
      publicIds[14]!,
      familyA,
      memberA,
      "INSERT INTO upload_sessions (public_id,family_id,created_by_member_id,original_filename,declared_size,committed_offset,state,terminal_at,expires_at) VALUES (?,?,?,'failed-no-code',1,0,'FAILED',CURRENT_TIMESTAMP(3),DATE_ADD(CURRENT_TIMESTAMP(3), INTERVAL 1 DAY))",
      [3819],
      rejectionKinds,
    );
    await expectRawRejection(
      connection,
      publicIds[15]!,
      familyA,
      memberA,
      "INSERT INTO upload_sessions (public_id,family_id,created_by_member_id,original_filename,declared_size,committed_offset,state,expires_at) VALUES (?,?,?,'aborted-no-terminal',1,0,'ABORTED',DATE_ADD(CURRENT_TIMESTAMP(3), INTERVAL 1 DAY))",
      [3819],
      rejectionKinds,
    );
    await expectRawRejection(
      connection,
      publicIds[16]!,
      familyA,
      memberA,
      "INSERT INTO upload_sessions (public_id,family_id,created_by_member_id,original_filename,declared_size,committed_offset,state,expires_at) VALUES (?,?,?,'expired-no-terminal',1,0,'EXPIRED',DATE_ADD(CURRENT_TIMESTAMP(3), INTERVAL 1 DAY))",
      [3819],
      rejectionKinds,
    );
    await expectRawRejection(
      connection,
      publicIds[17]!,
      familyA,
      memberA,
      "INSERT INTO upload_sessions (public_id,family_id,created_by_member_id,original_filename,declared_size,committed_offset,state,computed_sha256,expires_at) VALUES (?,?,?,'bad-pair',1,0,'CREATED',?,DATE_ADD(CURRENT_TIMESTAMP(3), INTERVAL 1 DAY))",
      [3819],
      rejectionKinds,
      [hash],
    );
    await expectRawRejection(
      connection,
      publicIds[18]!,
      familyA,
      memberA,
      "INSERT INTO upload_sessions (public_id,family_id,created_by_member_id,original_filename,declared_size,committed_offset,state,staging_cleaned_at,expires_at) VALUES (?,?,?,'bad-cleanup',1,0,'CREATED',CURRENT_TIMESTAMP(3),DATE_ADD(CURRENT_TIMESTAMP(3), INTERVAL 1 DAY))",
      [3819],
      rejectionKinds,
    );

    await insertValidStateRows(connection, familyA, memberA, publicIds, hash);

    const [bigRows] = await connection.query<BigIntRow[]>(
      `SELECT CAST(s.byte_size AS CHAR) AS byteSize,
              CAST(u.declared_size AS CHAR) AS declaredSize,
              CAST(u.committed_offset AS CHAR) AS committedOffset
         FROM storage_objects s JOIN upload_sessions u ON u.id = ?
        WHERE s.id = ?`,
      [createdUpload, storageA],
    );
    if (
      bigRows[0]?.byteSize !== big ||
      bigRows[0]?.declaredSize !== big ||
      bigRows[0]?.committedOffset !== "0"
    ) {
      throw new Error("mysql2 BIGINT string round-trip failed");
    }
    const db = drizzle(connection);
    const [drizzleStorage] = await db
      .select({ byteSize: storageObjects.byteSize })
      .from(storageObjects)
      .where(eq(storageObjects.id, BigInt(storageA)));
    const [drizzleUpload] = await db
      .select({ declaredSize: uploadSessions.declaredSize })
      .from(uploadSessions)
      .where(eq(uploadSessions.id, BigInt(createdUpload)));
    if (
      drizzleStorage?.byteSize !== 9007199254740993n ||
      drizzleUpload?.declaredSize !== 9007199254740993n
    ) {
      throw new Error("Drizzle BIGINT bigint round-trip failed");
    }

    const [[receiptCount]] = await connection.query<CountRow[]>(
      "SELECT CAST(COUNT(*) AS CHAR) AS count FROM upload_sessions WHERE family_id = ? AND storage_object_id = ?",
      [familyA, storageA],
    );
    if (receiptCount?.count !== "2") {
      throw new Error("Independent dedupe receipt semantics failed");
    }

    await connection.rollback();
    transactionStarted = false;
  } catch (error) {
    if (transactionStarted) await connection.rollback();
    throw error;
  }

  const [[remaining]] = await connection.query<CountRow[]>(
    `SELECT CAST(
       (SELECT COUNT(*) FROM storage_objects WHERE id IN (?,?,?)) +
       (SELECT COUNT(*) FROM upload_sessions WHERE family_id IN (?,?)) +
       (SELECT COUNT(*) FROM family_members WHERE id IN (?,?,?)) +
       (SELECT COUNT(*) FROM users WHERE id IN (?,?,?)) +
       (SELECT COUNT(*) FROM families WHERE id IN (?,?))
       AS CHAR) AS count`,
    [
      storageA,
      storageA2,
      storageB,
      familyA,
      familyB,
      memberA,
      memberA2,
      memberB,
      userA,
      userA2,
      userB,
      familyA,
      familyB,
    ],
  );
  if (remaining?.count !== "0") {
    throw new Error("Synthetic Phase 3 verification rows remain");
  }

  process.stdout.write(
    `${JSON.stringify(
      {
        status: "PHASE_3_LIVE_VERIFICATION_PASS",
        database: identity.databaseName,
        mysqlVersion: identity.version,
        currentUser: identity.currentUser,
        ...health,
        migrationCount: readiness.migrationCount,
        tables: tables.map((row) => row.tableName),
        indexes,
        foreignKeys,
        checks,
        sameFamilyExactDedupe: "PASS (1062)",
        sameFamilySameHashDifferentSize: "PASS",
        crossFamilySameObjectIdentity: "PASS",
        creatorFamilyFk: "PASS (1452)",
        uploadStorageFamilyFk: "PASS (1452)",
        offsetRuntimeChecks: "PASS",
        stateMachineRuntimeChecks:
          "PASS (all seven valid states + invalid combinations)",
        publicIdUniqueness: "PASS (1062)",
        bigintRoundTrip:
          "PASS (mysql2 string + Drizzle bigint 9007199254740993)",
        receiptSemantics: "PASS (two independent receipts, one storage object)",
        observedRejectionErrnos: [...rejectionKinds].sort((a, b) => a - b),
        syntheticRowsRemaining: remaining.count,
      },
      null,
      2,
    )}\n`,
  );
} finally {
  connection.release();
  await pool.end();
}

async function insertAndReadId(
  connection: PoolConnection,
  statement: string,
  values: unknown[],
) {
  await connection.query<ResultSetHeader>(statement, values);
  const [rows] = await connection.query<IdRow[]>(
    "SELECT CAST(LAST_INSERT_ID() AS CHAR) AS id",
  );
  const id = rows[0]?.id;
  if (!id) throw new Error("Synthetic insert ID is unavailable");
  return id;
}

function insertUser(connection: PoolConnection, username: string) {
  return insertAndReadId(
    connection,
    "INSERT INTO users (username,username_normalized,password_hash,password_changed_at) VALUES (?,?,'synthetic-verification-placeholder',CURRENT_TIMESTAMP(3))",
    [username, Buffer.from(username)],
  );
}

function insertMember(
  connection: PoolConnection,
  familyId: string,
  userId: string,
) {
  return insertAndReadId(
    connection,
    "INSERT INTO family_members (family_id,user_id,role) VALUES (?,?,'MEMBER')",
    [familyId, userId],
  );
}

function insertStorage(
  connection: PoolConnection,
  familyId: string,
  hash: Buffer,
  size: string,
) {
  return insertAndReadId(
    connection,
    "INSERT INTO storage_objects (family_id,sha256,byte_size,key_version,state,durable_at,verified_at) VALUES (?,?,?,1,'AVAILABLE',CURRENT_TIMESTAMP(3),CURRENT_TIMESTAMP(3))",
    [familyId, hash, size],
  );
}

type UploadInput = {
  publicId: Buffer;
  familyId: string;
  memberId: string;
  filename: string;
  declaredSize: string;
  committedOffset: string;
  state: string;
};

function insertUpload(connection: PoolConnection, input: UploadInput) {
  return insertAndReadId(
    connection,
    "INSERT INTO upload_sessions (public_id,family_id,created_by_member_id,original_filename,declared_size,committed_offset,state,expires_at) VALUES (?,?,?,?,?,?,?,DATE_ADD(CURRENT_TIMESTAMP(3), INTERVAL 1 DAY))",
    [
      input.publicId,
      input.familyId,
      input.memberId,
      input.filename,
      input.declaredSize,
      input.committedOffset,
      input.state,
    ],
  );
}

function insertCompleteUpload(
  connection: PoolConnection,
  input: {
    publicId: Buffer;
    familyId: string;
    memberId: string;
    filename: string;
    size: string;
    hash: Buffer;
    storageObjectId: string;
  },
) {
  return insertAndReadId(
    connection,
    "INSERT INTO upload_sessions (public_id,family_id,created_by_member_id,original_filename,declared_size,committed_offset,state,computed_sha256,finalize_started_at,storage_object_id,completed_at,expires_at) VALUES (?,?,?,?,?,?,'COMPLETE',?,CURRENT_TIMESTAMP(3),?,CURRENT_TIMESTAMP(3),DATE_ADD(CURRENT_TIMESTAMP(3), INTERVAL 1 DAY))",
    [
      input.publicId,
      input.familyId,
      input.memberId,
      input.filename,
      input.size,
      input.size,
      input.hash,
      input.storageObjectId,
    ],
  );
}

async function expectInvalidUpload(
  connection: PoolConnection,
  publicId: Buffer,
  familyId: string,
  memberId: string,
  label: string,
  values: Pick<UploadInput, "declaredSize" | "committedOffset" | "state">,
  expectedErrnos: number[],
  observed: Set<number>,
) {
  await expectRejection(
    () =>
      insertUpload(connection, {
        publicId,
        familyId,
        memberId,
        filename: `${label}.bin`,
        ...values,
      }),
    expectedErrnos,
    label,
    observed,
    false,
  );
}

async function expectRawRejection(
  connection: PoolConnection,
  publicId: Buffer,
  familyId: string,
  memberId: string,
  statement: string,
  expectedErrnos: number[],
  observed: Set<number>,
  extra: unknown[] = [],
) {
  await expectRejection(
    () => connection.query(statement, [publicId, familyId, memberId, ...extra]),
    expectedErrnos,
    "runtime constraint",
    observed,
    false,
  );
}

async function expectRejection(
  operation: () => Promise<unknown>,
  expectedErrnos: number[],
  expectedConstraint: string,
  observed: Set<number>,
  requireConstraint = true,
) {
  try {
    await operation();
  } catch (error) {
    const mysqlError = error as { errno?: number; sqlMessage?: string };
    if (
      mysqlError.errno !== undefined &&
      expectedErrnos.includes(mysqlError.errno) &&
      (!requireConstraint ||
        mysqlError.sqlMessage?.includes(expectedConstraint))
    ) {
      observed.add(mysqlError.errno);
      return;
    }
    throw new Error(`Unexpected MySQL rejection for ${expectedConstraint}`, {
      cause: error,
    });
  }
  throw new Error(
    `Expected MySQL rejection for ${expectedConstraint}, but the write succeeded`,
  );
}

async function insertValidStateRows(
  connection: PoolConnection,
  familyId: string,
  memberId: string,
  publicIds: Buffer[],
  hash: Buffer,
) {
  const rows: Array<[Buffer, string, unknown[]]> = [
    [
      publicIds[1]!,
      "INSERT INTO upload_sessions (public_id,family_id,created_by_member_id,original_filename,declared_size,committed_offset,state,expires_at) VALUES (?,?,?,'valid-uploading',2,1,'UPLOADING',DATE_ADD(CURRENT_TIMESTAMP(3), INTERVAL 1 DAY))",
      [],
    ],
    [
      publicIds[2]!,
      "INSERT INTO upload_sessions (public_id,family_id,created_by_member_id,original_filename,declared_size,committed_offset,state,computed_sha256,finalize_started_at,expires_at) VALUES (?,?,?,'valid-finalizing',1,1,'FINALIZING',?,CURRENT_TIMESTAMP(3),DATE_ADD(CURRENT_TIMESTAMP(3), INTERVAL 1 DAY))",
      [hash],
    ],
    [
      publicIds[5]!,
      "INSERT INTO upload_sessions (public_id,family_id,created_by_member_id,original_filename,declared_size,committed_offset,state,terminal_at,failure_code,expires_at) VALUES (?,?,?,'valid-failed',1,0,'FAILED',CURRENT_TIMESTAMP(3),'SYNTHETIC_FAILURE',DATE_ADD(CURRENT_TIMESTAMP(3), INTERVAL 1 DAY))",
      [],
    ],
    [
      publicIds[6]!,
      "INSERT INTO upload_sessions (public_id,family_id,created_by_member_id,original_filename,declared_size,committed_offset,state,terminal_at,expires_at) VALUES (?,?,?,'valid-aborted',1,0,'ABORTED',CURRENT_TIMESTAMP(3),DATE_ADD(CURRENT_TIMESTAMP(3), INTERVAL 1 DAY))",
      [],
    ],
    [
      publicIds[7]!,
      "INSERT INTO upload_sessions (public_id,family_id,created_by_member_id,original_filename,declared_size,committed_offset,state,terminal_at,expires_at) VALUES (?,?,?,'valid-expired',1,0,'EXPIRED',CURRENT_TIMESTAMP(3),DATE_ADD(CURRENT_TIMESTAMP(3), INTERVAL 1 DAY))",
      [],
    ],
  ];
  for (const [publicId, statement, extra] of rows) {
    await connection.query(statement, [publicId, familyId, memberId, ...extra]);
  }
}
