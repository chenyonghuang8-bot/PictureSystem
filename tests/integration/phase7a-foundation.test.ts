import { randomBytes, randomUUID } from "node:crypto";
import type { PoolConnection, RowDataPacket } from "mysql2/promise";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";
import {
  acquireCheckedConnection,
  assertMigrationReadiness,
  loadExpectedMigrationManifest,
  AuditRepository,
  CommitOutcomeUnknownError,
  createDatabase,
  PurgeIntentRepository,
  runTransaction,
} from "../../packages/db/src/index.js";
import {
  cleanupPhase6MigrationFixture,
  createPhase6SchemaFixture,
} from "../../packages/db/scripts/phase6-schema-fixture.js";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("PHASE7A_DEV_ENV_REQUIRED");
type Fixture = Awaited<ReturnType<typeof createPhase6SchemaFixture>>;
const trash = "2020-01-01 00:00:00.123";
const deadline = "2020-01-31 00:00:00.123";
const historicalId = "18446744073709550000";

function barrier() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve: () => resolve() };
}

// Extract only the expected identity, never print raw driver messages or payloads.
function errorIdentity(error: unknown) {
  const e = error as { errno?: number; code?: string; sqlMessage?: string };
  const message = String(e?.sqlMessage ?? "");
  const name =
    e?.errno === 1062
      ? /for key '([^']+)'/.exec(message)?.[1]
      : e?.errno === 3819
        ? /Check constraint '([^']+)' is violated/.exec(message)?.[1]
        : e?.errno === 1452
          ? /CONSTRAINT `([^`]+)` FOREIGN KEY/.exec(message)?.[1]
          : e?.errno === 1265
            ? /Data truncated for column '([^']+)'/.exec(message)?.[1]
            : undefined;
  return { errno: e?.errno, code: e?.code, name };
}
async function rejectsIdentity(
  promise: Promise<unknown>,
  errno: number,
  name: string,
  table?: string,
) {
  let failed = false;
  try {
    await promise;
  } catch (error) {
    failed = true;
    const identity = errorIdentity(error);
    expect(identity.errno).toBe(errno);
    const allowed = table ? [name, `${table}.${name}`] : [name];
    expect(allowed).toContain(identity.name);
  }
  expect(failed).toBe(true);
}

describe.sequential(
  "Phase 7A live frozen-schema and repository foundation",
  () => {
    const database = createDatabase(url);
    const repository = new PurgeIntentRepository(database.pool);
    let c: PoolConnection;
    let a: Fixture;
    let b: Fixture;
    let owned: Fixture[] = [];

    beforeAll(async () => {
      const conn = await acquireCheckedConnection(database.pool);
      try {
        const [identity] = await conn.query<RowDataPacket[]>(
          "SELECT DATABASE() db,VERSION() version,CURRENT_USER() account",
        );
        expect(identity[0]?.db).toBe("family_album_dev");
        expect(identity[0]?.version).toBe("9.7.2");
        expect(
          String(identity[0]?.account).split("@")[0]?.toLowerCase(),
        ).not.toBe("root");
        expect((await assertMigrationReadiness(conn)).migrationCount).toBe(
          (await loadExpectedMigrationManifest()).length,
        );
      } finally {
        conn.release();
      }
    });
    beforeEach(async () => {
      owned = [];
      c = await acquireCheckedConnection(database.pool);
      await c.beginTransaction();
      try {
        a = await createPhase6SchemaFixture(c);
        owned.push(a);
        b = await createPhase6SchemaFixture(c);
        owned.push(b);
        await c.commit();
      } catch (error) {
        await c.rollback();
        throw error;
      }
    });
    afterEach(async () => {
      if (!c) return;
      try {
        await c.rollback();
        for (const fixture of owned) {
          await c.beginTransaction();
          try {
            // Exact current-run family ownership; children before referenced parents.
            for (const table of [
              "audit_logs",
              "purge_files",
              "media_items",
              "upload_sessions",
              "purge_intents",
            ])
              await c.query(`DELETE FROM ${table} WHERE family_id=?`, [
                fixture.familyId,
              ]);
            await c.commit();
          } catch (error) {
            await c.rollback();
            throw error;
          }
          await cleanupPhase6MigrationFixture(c, fixture);
          for (const table of [
            "audit_logs",
            "purge_files",
            "purge_intents",
            "media_items",
            "upload_sessions",
            "storage_objects",
            "family_members",
            "albums",
          ]) {
            const [rows] = await c.query<RowDataPacket[]>(
              `SELECT COUNT(*) n FROM ${table} WHERE family_id=?`,
              [fixture.familyId],
            );
            expect(Number(rows[0]?.n)).toBe(0);
          }
          const [parents] = await c.query<RowDataPacket[]>(
            "SELECT (SELECT COUNT(*) FROM families WHERE id=?)+(SELECT COUNT(*) FROM users WHERE id IN (?,?))+(SELECT COUNT(*) FROM sessions WHERE user_id IN (?,?)) n",
            [
              fixture.familyId,
              fixture.userId,
              fixture.actorUserId,
              fixture.userId,
              fixture.actorUserId,
            ],
          );
          expect(Number(parents[0]?.n)).toBe(0);
        }
      } finally {
        c.release();
      }
    });
    afterAll(async () => {
      await database.pool.end();
    });

    async function insert(table: string, fields: Record<string, unknown>) {
      await c.query(`INSERT INTO ${table} SET ?`, [fields]);
      const [rows] = await c.query<RowDataPacket[]>(
        "SELECT CAST(LAST_INSERT_ID() AS CHAR) id",
      );
      return String(rows[0]!.id);
    }
    const intentFields = (
      fixture: Fixture,
      overrides: Record<string, unknown> = {},
    ) => ({
      family_id: fixture.familyId,
      operation_id: randomUUID(),
      media_id: fixture.mediaId,
      storage_object_id: fixture.objectId,
      source_upload_id: fixture.uploadId,
      lifecycle_revision: "1",
      trashed_at: trash,
      purge_after: deadline,
      request_source: "MANUAL",
      actor_member_id: fixture.actorMemberId,
      original_bytes: "16",
      ...overrides,
    });
    const originalFields = (
      intentId: string,
      overrides: Record<string, unknown> = {},
    ) => ({
      family_id: a.familyId,
      purge_intent_id: intentId,
      file_kind: "ORIGINAL",
      original_singleton_slot: 1,
      identity_key: randomBytes(32),
      storage_object_id: a.objectId,
      content_sha256: randomBytes(32),
      byte_size: "16",
      root_marker_id: "synthetic-phase7a",
      root_device: "1",
      ...overrides,
    });
    const derivedFields = (
      intentId: string,
      overrides: Record<string, unknown> = {},
    ) => ({
      ...originalFields(intentId),
      file_kind: "DERIVED",
      original_singleton_slot: null,
      storage_object_id: null,
      media_id: a.mediaId,
      generation: "1",
      recipe_id: 1,
      derived_kind: "THUMBNAIL",
      producer_job_id: historicalId,
      producer_epoch: "1",
      ...overrides,
    });
    const uploadFields = (overrides: Record<string, unknown> = {}) => ({
      public_id: randomBytes(16),
      family_id: a.familyId,
      created_by_member_id: a.memberId,
      original_filename: "synthetic-phase7a.bin",
      declared_size: "16",
      committed_offset: "16",
      state: "COMPLETE",
      computed_sha256: randomBytes(32),
      finalize_started_at: "2021-01-01 00:00:00.000",
      storage_object_id: a.objectId,
      completed_at: "2021-01-01 00:00:00.000",
      expires_at: "2022-01-01 00:00:00.000",
      created_at: "2020-01-01 00:00:00.000",
      ...overrides,
    });
    const auditFields = (overrides: Record<string, unknown> = {}) => ({
      family_id: a.familyId,
      operation_id: randomUUID(),
      media_id: historicalId,
      storage_object_id: historicalId,
      actor_kind: "SYSTEM",
      actor_member_id: null,
      action: "PURGE_STARTED",
      lifecycle_revision: "1",
      transition_id: randomUUID(),
      result_category: "SUCCESS",
      ...overrides,
    });

    it("F1: first ORIGINAL succeeds; a different identity cannot create a second ORIGINAL", async () => {
      const id = await insert("purge_intents", intentFields(a));
      await insert("purge_files", originalFields(id));
      await rejectsIdentity(
        insert("purge_files", originalFields(id)),
        1062,
        "uq_purge_files_original_singleton",
        "purge_files",
      );
    });
    it.each(["original-null", "original-two", "derived-non-null"])(
      "F1: rejects singleton shape %s",
      async (kind) => {
        const id = await insert("purge_intents", intentFields(a));
        const fields =
          kind === "derived-non-null"
            ? derivedFields(id, { original_singleton_slot: 1 })
            : originalFields(id, {
                original_singleton_slot: kind === "original-null" ? null : 2,
              });
        await rejectsIdentity(
          insert("purge_files", fields),
          3819,
          "chk_purge_files_original_singleton",
        );
      },
    );
    it("allows distinct DERIVED identities, rejects duplicate identity and cross-family intent", async () => {
      const id = await insert("purge_intents", intentFields(a));
      const fields = derivedFields(id);
      await insert("purge_files", fields);
      await insert("purge_files", derivedFields(id));
      await rejectsIdentity(
        insert("purge_files", fields),
        1062,
        "uq_purge_files_identity",
        "purge_files",
      );
      const foreign = await insert("purge_intents", intentFields(b));
      await rejectsIdentity(
        insert("purge_files", derivedFields(foreign)),
        1452,
        "fk_purge_files_intent",
      );
      const manifest = await repository.manifest(a.familyId, id);
      expect(manifest).toHaveLength(2);
      expect(await repository.manifest(b.familyId, id)).toHaveLength(0);
    });
    it("enforces manifest quarantine/kind/size CHECKs", async () => {
      const id = await insert("purge_intents", intentFields(a));
      for (const [fields, name] of [
        [
          originalFields(id, { stage: "QUARANTINED" }),
          "chk_purge_files_quarantine",
        ],
        [
          originalFields(id, { stage: "ABSENT_DERIVED" }),
          "chk_purge_files_kind",
        ],
        [derivedFields(id, { generation: null }), "chk_purge_files_kind"],
        [derivedFields(id, { byte_size: "0" }), "chk_purge_files_size"],
      ] as const)
        await rejectsIdentity(insert("purge_files", fields), 3819, name);
    });

    it.each(["media_items", "purge_intents"])(
      "F2: actual %s INSERT/UPDATE accepts exact 30d and rejects 29d/31d/overflow",
      async (table) => {
        const name =
          table === "media_items"
            ? "chk_media_items_trash_state"
            : "chk_purge_intents_retention";
        if (table === "media_items") {
          await c.query(
            "UPDATE media_items SET trashed_at=?,trashed_by_member_id=?,purge_after=? WHERE id=?",
            [trash, a.actorMemberId, deadline, a.mediaId],
          );
          for (const after of [
            "2020-01-30 00:00:00.123",
            "2020-02-01 00:00:00.123",
          ])
            await rejectsIdentity(
              c.query("UPDATE media_items SET purge_after=? WHERE id=?", [
                after,
                a.mediaId,
              ]),
              3819,
              name,
            );
          await rejectsIdentity(
            c.query(
              "UPDATE media_items SET trashed_at='9999-12-31 00:00:00.123',purge_after='9999-12-31 00:00:00.123' WHERE id=?",
              [a.mediaId],
            ),
            3819,
            name,
          );
        } else {
          const id = await insert(table, intentFields(a));
          for (const after of [
            "2020-01-30 00:00:00.123",
            "2020-02-01 00:00:00.123",
          ])
            await rejectsIdentity(
              c.query("UPDATE purge_intents SET purge_after=? WHERE id=?", [
                after,
                id,
              ]),
              3819,
              name,
            );
          await rejectsIdentity(
            c.query(
              "UPDATE purge_intents SET trashed_at='9999-12-31 00:00:00.123',purge_after='9999-12-31 00:00:00.123',requested_at='9999-12-31 00:00:00.123',available_at='9999-12-31 00:00:00.123' WHERE id=?",
              [id],
            ),
            3819,
            name,
          );
        }
      },
    );
    it("enforces ACTIVE/TRASHED/purge-requested shape, revision and actor family FK", async () => {
      const [rows] = await c.query<RowDataPacket[]>(
        "SELECT lifecycle_revision,trashed_at,trashed_by_member_id,purge_after,purge_intent_id FROM media_items WHERE id=?",
        [a.mediaId],
      );
      expect(String(rows[0]?.lifecycle_revision)).toBe("1");
      expect([
        rows[0]?.trashed_at,
        rows[0]?.trashed_by_member_id,
        rows[0]?.purge_after,
        rows[0]?.purge_intent_id,
      ]).toEqual([null, null, null, null]);
      await rejectsIdentity(
        c.query("UPDATE media_items SET lifecycle_revision=0 WHERE id=?", [
          a.mediaId,
        ]),
        3819,
        "chk_media_items_lifecycle_revision",
      );
      const id = await insert("purge_intents", intentFields(a));
      for (const fields of [
        { trashed_by_member_id: a.actorMemberId },
        { purge_after: deadline },
        { trashed_at: trash },
        { purge_intent_id: id },
      ])
        await rejectsIdentity(
          c.query("UPDATE media_items SET ? WHERE id=?", [fields, a.mediaId]),
          3819,
          "chk_media_items_trash_state",
        );
      await c.query(
        "UPDATE media_items SET trashed_at=?,trashed_by_member_id=?,purge_after=? WHERE id=?",
        [trash, a.actorMemberId, deadline, a.mediaId],
      );
      await c.query("UPDATE media_items SET purge_intent_id=? WHERE id=?", [
        id,
        a.mediaId,
      ]);
      await rejectsIdentity(
        c.query("UPDATE media_items SET trashed_by_member_id=? WHERE id=?", [
          b.actorMemberId,
          a.mediaId,
        ]),
        1452,
        "fk_media_items_trashed_by",
      );
      const foreign = await insert("purge_intents", intentFields(b));
      await rejectsIdentity(
        c.query("UPDATE media_items SET purge_intent_id=? WHERE id=?", [
          foreign,
          a.mediaId,
        ]),
        1452,
        "fk_media_items_purge_intent",
      );
    });
    it("enforces exact intent lifecycle/operation identities and family/actor FKs", async () => {
      const fields = intentFields(a);
      await insert("purge_intents", fields);
      await rejectsIdentity(
        insert("purge_intents", { ...fields, operation_id: randomUUID() }),
        1062,
        "uq_purge_intents_lifecycle",
        "purge_intents",
      );
      await rejectsIdentity(
        insert("purge_intents", {
          ...fields,
          operation_id: randomUUID(),
          request_source: "SCHEDULED",
        }),
        1062,
        "uq_purge_intents_lifecycle",
        "purge_intents",
      );
      await rejectsIdentity(
        insert("purge_intents", { ...fields, lifecycle_revision: "2" }),
        1062,
        "uq_purge_intents_operation",
        "purge_intents",
      );
      await rejectsIdentity(
        insert(
          "purge_intents",
          intentFields(a, { family_id: historicalId, actor_member_id: null }),
        ),
        1452,
        "fk_purge_intents_family",
      );
      await rejectsIdentity(
        insert(
          "purge_intents",
          intentFields(a, {
            lifecycle_revision: "2",
            actor_member_id: b.actorMemberId,
          }),
        ),
        1452,
        "fk_purge_intents_actor",
      );
    });
    it("enforces intent lease, progress, bytes, revision and attempt CHECKs", async () => {
      for (const [fields, name] of [
        [{ execution_state: "RUNNING" }, "chk_purge_intents_lease"],
        [{ worker_id: randomBytes(16) }, "chk_purge_intents_lease"],
        [
          {
            progress: "COMPLETED",
            execution_state: "DONE",
            completed_at: trash,
            worker_id: randomBytes(16),
            locked_at: trash,
            heartbeat_at: trash,
            locked_until: deadline,
            lease_epoch: "1",
          },
          "chk_purge_intents_lease",
        ],
        [
          { progress: "COMPLETED", execution_state: "DONE" },
          "chk_purge_intents_progress",
        ],
        [{ execution_state: "DONE" }, "chk_purge_intents_progress"],
        [{ original_bytes: "0" }, "chk_purge_intents_bytes"],
        [{ released_bytes: "17" }, "chk_purge_intents_bytes"],
        [{ lifecycle_revision: "0" }, "chk_purge_intents_revision"],
        [{ max_attempts: 0 }, "chk_purge_intents_attempts"],
      ] as const)
        await rejectsIdentity(
          insert("purge_intents", intentFields(a, fields)),
          3819,
          name,
        );
    });

    it("keeps COMPLETE strict and accepts complete historical RETIRED without live storage FK", async () => {
      await insert("upload_sessions", uploadFields());
      await rejectsIdentity(
        insert("upload_sessions", uploadFields({ storage_object_id: null })),
        3819,
        "chk_upload_sessions_complete",
      );
      await rejectsIdentity(
        insert(
          "upload_sessions",
          uploadFields({ retired_storage_object_id: historicalId }),
        ),
        3819,
        "chk_upload_sessions_complete",
      );
      const intent = await insert("purge_intents", intentFields(a));
      const retired = uploadFields({
        state: "RETIRED",
        storage_object_id: null,
        retired_storage_object_id: historicalId,
        retired_purge_id: intent,
        retired_at: "2021-01-02 00:00:00.000",
      });
      await insert("upload_sessions", retired);
      for (const fields of [
        { storage_object_id: a.objectId },
        { retired_at: null },
        { retired_storage_object_id: null },
        { retired_purge_id: null },
      ])
        await rejectsIdentity(
          insert("upload_sessions", {
            ...retired,
            ...fields,
            public_id: randomBytes(16),
          }),
          3819,
          "chk_upload_sessions_complete",
        );
      await rejectsIdentity(
        insert("upload_sessions", {
          ...retired,
          public_id: randomBytes(16),
          failure_code: "SYNTHETIC",
        }),
        3819,
        "chk_upload_sessions_failure",
      );
      await rejectsIdentity(
        insert("upload_sessions", {
          ...retired,
          public_id: randomBytes(16),
          terminal_at: "2021-01-02 00:00:00.000",
        }),
        3819,
        "chk_upload_sessions_complete",
      );
      const foreign = await insert("purge_intents", intentFields(b));
      await rejectsIdentity(
        insert("upload_sessions", {
          ...retired,
          public_id: randomBytes(16),
          retired_purge_id: foreign,
        }),
        1452,
        "fk_upload_sessions_retired_purge",
      );
      const [fk] = await c.query<RowDataPacket[]>(
        "SELECT CONSTRAINT_NAME FROM information_schema.KEY_COLUMN_USAGE WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='upload_sessions' AND COLUMN_NAME='retired_storage_object_id' AND REFERENCED_TABLE_NAME IS NOT NULL",
      );
      expect(fk).toHaveLength(0);
    });
    it("accepts PURGING and all pre-existing storage enum states", async () => {
      for (const state of ["AVAILABLE", "MISSING", "CORRUPT", "PURGING"])
        await insert("storage_objects", {
          family_id: a.familyId,
          sha256: randomBytes(32),
          byte_size: "16",
          state,
          durable_at: trash,
          verified_at: trash,
        });
      // Additional storage rows are owned by this exact fixture family.
      await c.query("DELETE FROM storage_objects WHERE family_id=? AND id<>?", [
        a.familyId,
        a.objectId,
      ]);
    });
    it("audit enforces transition identity, enum/actor/family boundaries without live media/storage parents or private fields", async () => {
      const fields = auditFields();
      await insert("audit_logs", fields);
      await rejectsIdentity(
        insert("audit_logs", fields),
        1062,
        "uq_audit_logs_transition",
        "audit_logs",
      );
      await rejectsIdentity(
        insert("audit_logs", auditFields({ family_id: historicalId })),
        1452,
        "fk_audit_logs_family",
      );
      await rejectsIdentity(
        insert(
          "audit_logs",
          auditFields({ actor_kind: "MEMBER", actor_member_id: b.memberId }),
        ),
        1452,
        "fk_audit_logs_actor",
      );
      await rejectsIdentity(
        insert("audit_logs", auditFields({ actor_kind: "MEMBER" })),
        3819,
        "chk_audit_logs_actor",
      );
      const foreign = await insert("purge_intents", intentFields(b));
      await rejectsIdentity(
        insert("audit_logs", auditFields({ purge_intent_id: foreign })),
        1452,
        "fk_audit_logs_purge",
      );
      for (const field of ["action", "result_category", "actor_kind"])
        await rejectsIdentity(
          insert("audit_logs", auditFields({ [field]: "INVALID_SYNTHETIC" })),
          1265,
          field,
        );
      const [columns] = await c.query<RowDataPacket[]>(
        "SELECT COLUMN_NAME,DATA_TYPE FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='audit_logs'",
      );
      expect(columns.map((row) => row.COLUMN_NAME).sort()).toEqual(
        [
          "id",
          "family_id",
          "operation_id",
          "purge_intent_id",
          "media_id",
          "storage_object_id",
          "actor_kind",
          "actor_member_id",
          "action",
          "lifecycle_revision",
          "transition_id",
          "result_category",
          "created_at",
        ].sort(),
      );
      expect(
        columns.filter((row) => /text|blob|json/.test(String(row.DATA_TYPE))),
      ).toHaveLength(0);
      const [fks] = await c.query<RowDataPacket[]>(
        "SELECT REFERENCED_TABLE_NAME FROM information_schema.KEY_COLUMN_USAGE WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='audit_logs' AND COLUMN_NAME IN ('media_id','storage_object_id') AND REFERENCED_TABLE_NAME IS NOT NULL",
      );
      expect(fks).toHaveLength(0);
      const [rows] = await c.query<RowDataPacket[]>(
        "SELECT COUNT(*) n FROM audit_logs WHERE family_id=? AND media_id=? AND storage_object_id=?",
        [a.familyId, historicalId, historicalId],
      );
      expect(Number(rows[0]?.n)).toBe(1);
    });

    const repoInput = (fixture: Fixture) => ({
      familyId: fixture.familyId,
      operationId: randomUUID(),
      mediaId: fixture.mediaId,
      storageObjectId: fixture.objectId,
      sourceUploadId: fixture.uploadId,
      lifecycleRevision: 1n,
      trashedAt: new Date("2020-01-01T00:00:00.123Z"),
      purgeAfter: new Date("2020-01-31T00:00:00.123Z"),
      requestSource: "MANUAL" as const,
      actorMemberId: fixture.actorMemberId,
      originalBytes: 16n,
    });
    async function createOwnedIntent() {
      // Unfiltered claim must never take unrelated DEV work.
      const [rows] = await c.query<RowDataPacket[]>(
        "SELECT COUNT(*) n FROM purge_intents WHERE (execution_state IN ('QUEUED','RETRY_WAIT') AND available_at<=CURRENT_TIMESTAMP(3)) OR (execution_state='RUNNING' AND locked_until<CURRENT_TIMESTAMP(3))",
      );
      expect(Number(rows[0]?.n)).toBe(0);
      const input = repoInput(a);
      await c.beginTransaction();
      try {
        const result = await repository.create(c, input);
        await c.commit();
        return { input, ...result };
      } catch (error) {
        await c.rollback();
        throw error;
      }
    }
    it("repository create converges exact identity and rejects operation/lifecycle conflicts", async () => {
      const created = await createOwnedIntent();
      expect(created.created).toBe(true);
      await c.beginTransaction();
      try {
        expect(await repository.create(c, created.input)).toEqual({
          id: created.id,
          created: false,
        });
        await expect(
          repository.create(c, { ...created.input, operationId: randomUUID() }),
        ).rejects.toThrow("PURGE_IDENTITY_CONFLICT");
        await expect(
          repository.create(c, {
            ...created.input,
            requestSource: "SCHEDULED",
          }),
        ).rejects.toThrow("PURGE_IDENTITY_CONFLICT");
        await rejectsIdentity(
          repository.create(c, { ...created.input, mediaId: historicalId }),
          1062,
          "uq_purge_intents_operation",
          "purge_intents",
        );
        await c.commit();
      } catch (error) {
        await c.rollback();
        throw error;
      }
    });
    it("two real workers cannot double-claim: barrier holds first SELECT row lock until second SKIP LOCKED returns", async () => {
      const created = await createOwnedIntent();
      const locked = barrier();
      const release = barrier();
      const connectionIds = new Set<number>();
      const racedPool = new Proxy(database.pool, {
        get(target, key) {
          if (key === "getConnection")
            return async () => {
              const conn = await target.getConnection();
              connectionIds.add(conn.threadId);
              return new Proxy(conn, {
                get(connection, property) {
                  if (property === "execute")
                    return async (
                      sql: string,
                      values: Parameters<PoolConnection["execute"]>[1],
                    ) => {
                      const result = await connection.execute(sql, values);
                      if (
                        sql.includes("FOR UPDATE SKIP LOCKED") &&
                        Array.isArray(result[0]) &&
                        result[0].length === 1
                      ) {
                        expect(String((result[0][0] as RowDataPacket).id)).toBe(
                          created.id,
                        );
                        locked.resolve();
                        await release.promise;
                      }
                      return result;
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
      const raceRepository = new PurgeIntentRepository(racedPool);
      const first = raceRepository.claim(randomBytes(16));
      let second;
      try {
        await Promise.race([
          locked.promise,
          first.then(() => {
            throw new Error("FIRST_CLAIM_DID_NOT_REACH_LOCK_BARRIER");
          }),
        ]);
        second = await raceRepository.claim(randomBytes(16));
        expect(second).toBeNull();
        expect(connectionIds.size).toBe(2);
      } finally {
        release.resolve();
        await first;
      }
      const winner = await first;
      expect(winner?.id).toBe(created.id);
      expect(winner?.epoch).toBe(1n);
      const [rows] = await c.query<RowDataPacket[]>(
        "SELECT attempts,lease_epoch FROM purge_intents WHERE id=?",
        [created.id],
      );
      expect(Number(rows[0]?.attempts)).toBe(1);
      expect(String(rows[0]?.lease_epoch)).toBe("1");
    });
    it("repository reclaims expired leases, fences stale/expired mutations and completes progress", async () => {
      const created = await createOwnedIntent();
      const old = await repository.claim(randomBytes(16));
      expect(old?.id).toBe(created.id);
      if (!old) throw new Error("LEASE_REQUIRED");
      expect(await repository.heartbeat(old)).toBe(true);
      await c.query(
        "UPDATE purge_intents SET locked_until=CURRENT_TIMESTAMP(3)-INTERVAL 1 SECOND WHERE id=?",
        [created.id],
      );
      expect(await repository.heartbeat(old)).toBe(false);
      expect(await repository.advance(old, "REQUESTED", "DETACHED")).toBe(
        false,
      );
      expect(await repository.fail(old, "TRANSIENT_DB", 30)).toBe(false);
      const fresh = await repository.claim(randomBytes(16));
      expect(fresh?.epoch).toBe(old.epoch + 1n);
      if (!fresh) throw new Error("LEASE_REQUIRED");
      expect(await repository.heartbeat(old)).toBe(false);
      expect(await repository.advance(old, "REQUESTED", "DETACHED")).toBe(
        false,
      );
      expect(await repository.fail(old, "TRANSIENT_DB", 30)).toBe(false);
      expect(await repository.advance(fresh, "REQUESTED", "DETACHED")).toBe(
        true,
      );
      expect(await repository.advance(fresh, "REQUESTED", "DETACHED")).toBe(
        false,
      );
      expect(await repository.advance(fresh, "DETACHED", "FILES_REMOVED")).toBe(
        true,
      );
      expect(
        await repository.advance(fresh, "FILES_REMOVED", "COMPLETED"),
      ).toBe(true);
      const found = await repository.findIdentity(a.familyId, a.mediaId, 1n);
      expect(found?.progress).toBe("COMPLETED");
      expect(found?.executionState).toBe("DONE");
      expect(await repository.heartbeat(fresh)).toBe(false);
      const [rows] = await c.query<RowDataPacket[]>(
        "SELECT worker_id,locked_at,heartbeat_at,locked_until,completed_at FROM purge_intents WHERE id=?",
        [created.id],
      );
      expect([
        rows[0]?.worker_id,
        rows[0]?.locked_at,
        rows[0]?.heartbeat_at,
        rows[0]?.locked_until,
      ]).toEqual([null, null, null, null]);
      expect(rows[0]?.completed_at).toBeInstanceOf(Date);
    });
    it("repository retry and BLOCKED preserve fences; exhausted recovery is explicit", async () => {
      const created = await createOwnedIntent();
      const first = await repository.claim(randomBytes(16));
      if (!first) throw new Error("LEASE_REQUIRED");
      expect(await repository.fail(first, "TRANSIENT_DB", 30)).toBe(true);
      expect(
        (await repository.findIdentity(a.familyId, a.mediaId, 1n))
          ?.executionState,
      ).toBe("RETRY_WAIT");
      expect(await repository.claim()).toBeNull();
      await c.query(
        "UPDATE purge_intents SET available_at=CURRENT_TIMESTAMP(3) WHERE id=?",
        [created.id],
      );
      const second = await repository.claim(randomBytes(16));
      if (!second) throw new Error("LEASE_REQUIRED");
      expect(second.epoch).toBe(first.epoch + 1n);
      expect(await repository.fail(first, "TRANSIENT_DB", 30)).toBe(false);
      expect(await repository.fail(second, "INVARIANT_VIOLATION", null)).toBe(
        true,
      );
      expect(
        (await repository.findIdentity(a.familyId, a.mediaId, 1n))
          ?.executionState,
      ).toBe("BLOCKED");
      expect(await repository.claim()).toBeNull();
      await c.query(
        "UPDATE purge_intents SET execution_state='RUNNING',worker_id=?,lease_epoch=3,locked_at=CURRENT_TIMESTAMP(3),heartbeat_at=CURRENT_TIMESTAMP(3),locked_until=CURRENT_TIMESTAMP(3)-INTERVAL 1 SECOND,attempts=max_attempts WHERE id=?",
        [randomBytes(16), created.id],
      );
      expect(await repository.claim()).toBeNull();
      // Scope the otherwise unfiltered recovery primitive to our single known row.
      const [other] = await c.query<RowDataPacket[]>(
        "SELECT COUNT(*) n FROM purge_intents WHERE id<>? AND execution_state='RUNNING' AND attempts>=max_attempts AND locked_until<CURRENT_TIMESTAMP(3)",
        [created.id],
      );
      expect(Number(other[0]?.n)).toBe(0);
      expect(await repository.recoverExhausted(c)).toBe(1);
      expect(
        (await repository.findIdentity(a.familyId, a.mediaId, 1n))
          ?.executionState,
      ).toBe("BLOCKED");
    });
    it("audit repository appends only exact transition identity and propagates duplicate", async () => {
      const audit = new AuditRepository(database.pool);
      const input = {
        familyId: a.familyId,
        operationId: randomUUID(),
        purgeIntentId: null,
        mediaId: historicalId,
        storageObjectId: historicalId,
        actorKind: "SYSTEM" as const,
        actorMemberId: null,
        action: "PURGE_STARTED" as const,
        lifecycleRevision: 1n,
        transitionId: randomUUID(),
        resultCategory: "SUCCESS" as const,
      };
      expect(BigInt(await audit.append(input))).toBeGreaterThan(0n);
      await rejectsIdentity(
        audit.append(input),
        1062,
        "uq_audit_logs_transition",
        "audit_logs",
      );
      await audit.append({ ...input, transitionId: randomUUID() });
    });
    it("existing COMMIT fault seam commits once then returns UNKNOWN without replay", async () => {
      let operations = 0;
      let commits = 0;
      await expect(
        runTransaction(
          database.pool,
          async (conn) => {
            operations++;
            await conn.query("INSERT INTO audit_logs SET ?", [auditFields()]);
          },
          {
            acquire: () => acquireCheckedConnection(database.pool),
            commit: async (conn) => {
              commits++;
              await conn.commit();
              throw new Error("SYNTHETIC_COMMIT_ACK_UNKNOWN");
            },
          },
        ),
      ).rejects.toBeInstanceOf(CommitOutcomeUnknownError);
      expect(operations).toBe(1);
      expect(commits).toBe(1);
      const [rows] = await c.query<RowDataPacket[]>(
        "SELECT COUNT(*) n FROM audit_logs WHERE family_id=?",
        [a.familyId],
      );
      expect(Number(rows[0]?.n)).toBe(1);
    });
  },
);
