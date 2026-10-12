import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createDatabase,
  assertMigrationReadiness,
  runCheckedTransaction,
  acquireCheckedConnection,
  MySqlAdminReadRepository,
  MySqlSystemControlRepository,
  SystemControlError,
  MySqlPhase1CRepository,
  type Phase1CActor,
  type ResultSetHeader,
  type RowDataPacket,
  type Pool,
} from "../../packages/db/src/index.js";
import {
  hashPassword,
  hashSessionToken,
  createSessionToken,
} from "../../packages/auth/src/index.js";

if (!process.env.DATABASE_URL) throw new Error("PHASE11_DEV_DB_REQUIRED");
describe.sequential(
  "Phase11 real MySQL current authorization and observations",
  () => {
    const db = createDatabase(process.env.DATABASE_URL!),
      reads = new MySqlAdminReadRepository(db.pool),
      control = new MySqlSystemControlRepository(db.pool),
      members = new MySqlPhase1CRepository(db.pool),
      suffix = randomUUID().replaceAll("-", "");
    // Fixture SQL uses the same checked UTC session as application SQL. A raw
    // pool connection on this host defaults to local time and falsifies age tests.
    const fixturePool = {
      async query<T extends RowDataPacket[] | ResultSetHeader>(
        sql: string,
        values: unknown[] = [],
      ) {
        const c = await acquireCheckedConnection(db.pool);
        try {
          return await c.query<T>(sql, values);
        } finally {
          c.release();
        }
      },
    };
    const actors = new Map<
      string,
      Phase1CActor & { familyId: string; memberId: string }
    >();
    const bootIds: string[] = [],
      operations: string[] = [];
    let familyId = "",
      privateAlbum = "",
      hiddenMedia = "",
      grantId = "";
    const storage = async () => ({
      state: "UNKNOWN" as const,
      observedAt: null,
      staleAfter: null,
      source: "STORAGE_OWNER" as const,
      reasonCode: "WRITER_NOT_READY" as const,
      totalBytes: null,
      availableBytes: null,
    });
    function actor(name = "super") {
      return actors.get(name)!;
    }
    async function insert(sql: string, values: unknown[]) {
      const [r] = await fixturePool.query<ResultSetHeader>(sql, values);
      return String(r.insertId);
    }
    beforeAll(async () => {
      const c = await db.pool.getConnection();
      try {
        const [identity] = await c.query<RowDataPacket[]>(
          "SELECT DATABASE() db,CURRENT_USER() account",
        );
        expect(identity[0]!.db).toBe("family_album_dev");
        expect(String(identity[0]!.account).split("@")[0]).not.toBe("root");
        await assertMigrationReadiness(c);
      } finally {
        c.release();
      }
      const password = await hashPassword("synthetic-phase11-password");
      familyId = await insert("INSERT INTO families(name) VALUES(?)", [
        `phase11_admin_${suffix}`,
      ]);
      for (const [name, role, client] of [
        ["super", "SUPER_ADMIN", "WEB"],
        ["admin", "ADMIN", "ANDROID"],
        ["member", "MEMBER", "WEB"],
      ] as const) {
        const username = `phase11_${name}_${suffix}`,
          tokenHash = hashSessionToken(createSessionToken());
        const userId = await insert(
          "INSERT INTO users(username,username_normalized,password_hash,password_changed_at) VALUES(?,?,?,CURRENT_TIMESTAMP(3))",
          [username, Buffer.from(username), password],
        );
        const memberId = await insert(
          "INSERT INTO family_members(family_id,user_id,role) VALUES(?,?,?)",
          [familyId, userId, role],
        );
        const sessionId = await insert(
          "INSERT INTO sessions(user_id,token_hash,client_type,authenticated_at,last_seen_at,expires_at) VALUES(?,?,?,CURRENT_TIMESTAMP(3),CURRENT_TIMESTAMP(3),DATE_ADD(CURRENT_TIMESTAMP(3),INTERVAL 30 DAY))",
          [userId, tokenHash, client],
        );
        actors.set(name, {
          familyId,
          userId,
          memberId,
          sessionId,
          tokenHash,
          expectedClientType: client,
        });
      }
      privateAlbum = await insert(
        "INSERT INTO albums(family_id,owner_member_id,name,visibility) VALUES(?,?,?,'CUSTOM')",
        [familyId, actor("member").memberId, "synthetic private"],
      );
      const albums = [
        await insert(
          "INSERT INTO albums(family_id,owner_member_id,name,visibility) VALUES(?,?,?,'FAMILY')",
          [familyId, actor().memberId, "synthetic shared A"],
        ),
        await insert(
          "INSERT INTO albums(family_id,owner_member_id,name,visibility) VALUES(?,?,?,'FAMILY')",
          [familyId, actor().memberId, "synthetic shared B"],
        ),
      ];
      for (let i = 0; i < 3; i++) {
        const sha = randomBytes(32),
          objectId = await insert(
            "INSERT INTO storage_objects(family_id,sha256,byte_size,state,durable_at,verified_at) VALUES(?,?,16,'AVAILABLE',CURRENT_TIMESTAMP(3),CURRENT_TIMESTAMP(3))",
            [familyId, sha],
          );
        const uploader = i === 2 ? actor("member") : actor("admin");
        const uploadId = await insert(
          "INSERT INTO upload_sessions(public_id,family_id,created_by_member_id,original_filename,declared_size,committed_offset,state,computed_sha256,finalize_started_at,storage_object_id,completed_at,staging_cleaned_at,expires_at) VALUES(?,?,?,'synthetic.mp4',16,16,'COMPLETE',?,CURRENT_TIMESTAMP(3),?,CURRENT_TIMESTAMP(3),CURRENT_TIMESTAMP(3),DATE_ADD(CURRENT_TIMESTAMP(3),INTERVAL 1 DAY))",
          [randomBytes(16), familyId, uploader.memberId, sha, objectId],
        );
        const mediaId = await insert(
          "INSERT INTO media_items(family_id,storage_object_id,source_upload_id,uploaded_at,timeline_key,media_type,processing_state,metadata_generation) VALUES(?,?,?,CURRENT_TIMESTAMP(3),CURRENT_TIMESTAMP(3),'VIDEO','READY',1)",
          [familyId, objectId, uploadId],
        );
        for (const albumId of i === 2 ? [privateAlbum] : albums)
          await insert(
            "INSERT INTO album_media(family_id,album_id,media_id) VALUES(?,?,?)",
            [familyId, albumId, mediaId],
          );
        if (i === 2) hiddenMedia = mediaId;
        if (i === 0)
          await insert(
            "INSERT INTO upload_sessions(public_id,family_id,created_by_member_id,original_filename,declared_size,committed_offset,state,computed_sha256,finalize_started_at,storage_object_id,completed_at,staging_cleaned_at,expires_at) VALUES(?,?,?,'synthetic-duplicate.mp4',16,16,'COMPLETE',?,CURRENT_TIMESTAMP(3),?,CURRENT_TIMESTAMP(3),CURRENT_TIMESTAMP(3),DATE_ADD(CURRENT_TIMESTAMP(3),INTERVAL 1 DAY))",
            [
              randomBytes(16),
              familyId,
              actor("member").memberId,
              sha,
              objectId,
            ],
          );
      }
    }, 20000);
    afterAll(async () => {
      try {
        await runCheckedTransaction(db.pool, async (c) => {
          if (familyId) {
            const [owned] = await c.query<RowDataPacket[]>(
              "SELECT name FROM families WHERE id=? FOR UPDATE",
              [familyId],
            );
            if (owned[0]?.name !== `phase11_admin_${suffix}`)
              throw new Error("PHASE11_CLEANUP_IDENTITY_MISMATCH");
            // Append-only family/system audits survive synthetic fixture cleanup.
            await c.query("DELETE FROM system_admin_grants WHERE family_id=?", [
              familyId,
            ]);
            for (const bootId of bootIds)
              await c.query(
                "UPDATE admin_runtime_observations SET state='STOPPED',reason_code='STOPPED',exited_at=CURRENT_TIMESTAMP(3),received_at=CURRENT_TIMESTAMP(3) WHERE boot_id=? AND exited_at IS NULL",
                [bootId],
              );
            for (const table of [
              "album_media",
              "album_members",
              "media_items",
              "upload_sessions",
              "storage_objects",
              "invitations",
              "albums",
            ])
              await c.query(`DELETE FROM ${table} WHERE family_id=?`, [
                familyId,
              ]);
            for (const a of actors.values())
              await c.query("DELETE FROM sessions WHERE user_id=?", [a.userId]);
            await c.query("DELETE FROM family_members WHERE family_id=?", [
              familyId,
            ]);
            for (const a of actors.values())
              await c.query(
                "DELETE FROM users WHERE id=? AND username LIKE ?",
                [a.userId, `phase11_%_${suffix}`],
              );
            await c.query("DELETE FROM families WHERE id=?", [familyId]);
          }
        });
        const [rows] = await fixturePool.query<RowDataPacket[]>(
          "SELECT COUNT(*) n FROM families WHERE name=?",
          [`phase11_admin_${suffix}`],
        );
        expect(String(rows[0]!.n)).toBe("0");
      } finally {
        await db.pool.end();
      }
    });
    it("counts visible media and storage once across placements and duplicate receipts without SUPER_ADMIN private bypass", async () => {
      const r = await reads.overview(actor(), familyId);
      expect(r).toMatchObject({
        photos: "0",
        videos: "2",
        visibleLogicalBytes: "32",
        visibleReferencedStorageBytes: "32",
        visibleDerivedBytes: "0",
        uploaders: [
          {
            memberId: actor("admin").memberId,
            mediaCount: "2",
            logicalBytes: "32",
          },
        ],
        lastBackupSuccessAt: null,
        lastIntegritySuccessAt: null,
      });
      expect(r.backups.state).toBe("NOT_CONFIGURED");
      expect(r.integrity.state).toBe("NOT_CONFIGURED");
      expect(await reads.overview(actor("admin"), familyId)).toMatchObject({
        videos: "2",
      });
    });
    it("revalidates current ACL and excludes pending, trash and unavailable originals before aggregation", async () => {
      await insert(
        "INSERT INTO album_members(family_id,album_id,member_id,can_view) VALUES(?,?,?,1)",
        [familyId, privateAlbum, actor().memberId],
      );
      try {
        expect((await reads.overview(actor(), familyId)).videos).toBe("3");
      } finally {
        await fixturePool.query(
          "DELETE FROM album_members WHERE family_id=? AND album_id=? AND member_id=?",
          [familyId, privateAlbum, actor().memberId],
        );
      }
      expect((await reads.overview(actor(), familyId)).videos).toBe("2");
      await fixturePool.query(
        "UPDATE media_items SET trashed_at=CURRENT_TIMESTAMP(3),trashed_by_member_id=?,purge_after=DATE_ADD(CURRENT_TIMESTAMP(3),INTERVAL 30 DAY) WHERE id=? AND family_id=?",
        [actor("member").memberId, hiddenMedia, familyId],
      );
      try {
        expect((await reads.overview(actor(), familyId)).trash).toBe("0");
      } finally {
        await fixturePool.query(
          "UPDATE media_items SET trashed_at=NULL,trashed_by_member_id=NULL,purge_after=NULL WHERE id=? AND family_id=?",
          [hiddenMedia, familyId],
        );
      }
      await fixturePool.query(
        "UPDATE storage_objects SET state='MISSING' WHERE family_id=?",
        [familyId],
      );
      try {
        expect((await reads.overview(actor(), familyId)).videos).toBe("0");
      } finally {
        await fixturePool.query(
          "UPDATE storage_objects SET state='AVAILABLE' WHERE family_id=?",
          [familyId],
        );
      }
    });
    it("checks active role, session client type, revocation and expiry on every observation", async () => {
      await expect(
        reads.overview(actor("member"), familyId),
      ).rejects.toMatchObject({ reason: "FORBIDDEN" });
      await expect(
        reads.overview(
          { ...actor("admin"), expectedClientType: "WEB" },
          familyId,
        ),
      ).rejects.toMatchObject({ reason: "FORBIDDEN" });
      for (const [set, reset] of [
        ["role='MEMBER'", "role='ADMIN'"],
        ["disabled_at=CURRENT_TIMESTAMP(3)", "disabled_at=NULL"],
      ]) {
        await fixturePool.query(
          `UPDATE family_members SET ${set} WHERE id=? AND family_id=?`,
          [actor("admin").memberId, familyId],
        );
        try {
          await expect(
            reads.overview(actor("admin"), familyId),
          ).rejects.toMatchObject({ reason: "FORBIDDEN" });
        } finally {
          await fixturePool.query(
            `UPDATE family_members SET ${reset} WHERE id=? AND family_id=?`,
            [actor("admin").memberId, familyId],
          );
        }
      }
      await fixturePool.query(
        "UPDATE sessions SET revoked_at=CURRENT_TIMESTAMP(3),revoke_reason='USER_REVOKE' WHERE id=?",
        [actor("admin").sessionId],
      );
      try {
        await expect(
          reads.overview(actor("admin"), familyId),
        ).rejects.toMatchObject({ reason: "FORBIDDEN" });
      } finally {
        await fixturePool.query(
          "UPDATE sessions SET revoked_at=NULL,revoke_reason=NULL WHERE id=?",
          [actor("admin").sessionId],
        );
      }
    });
    it("requires an explicit synthetic independent grant and removes system visibility immediately on revocation", async () => {
      await expect(
        control.resolveActor(actor()).then(
          () => "AUTHORIZED",
          (error: unknown) =>
            error instanceof SystemControlError ? error.reason : "UNCLASSIFIED",
        ),
      ).resolves.toBe("FORBIDDEN");
      const operationId = randomUUID();
      operations.push(operationId);
      ({ grantId } = await control.localGrant({
        familyId,
        userId: actor().userId,
        enabled: true,
        operationId,
      }));
      const resolved = await control.resolveActor(actor());
      const r = await reads.systemStatus(resolved, ["API"], storage);
      expect(r.observations).toMatchObject({
        storage: { state: "UNKNOWN", availableBytes: null },
        backups: { state: "NOT_CONFIGURED" },
        lastBackupSuccessAt: null,
      });
      expect(r.observations.workers.find((w) => w.role === "API")?.state).toBe(
        "UNKNOWN",
      );
      const revoke = randomUUID();
      operations.push(revoke);
      await control.localGrant({
        familyId,
        userId: actor().userId,
        enabled: false,
        operationId: revoke,
      });
      await expect(
        reads.systemStatus(resolved, ["API"], storage),
      ).rejects.toMatchObject({ reason: "FORBIDDEN" });
      await expect(
        control.resolveActor(actor()).then(
          () => "AUTHORIZED",
          (error: unknown) =>
            error instanceof SystemControlError ? error.reason : "UNCLASSIFIED",
        ),
      ).resolves.toBe("FORBIDDEN");
      expect(grantId).toMatch(/^[1-9]\d*$/u);
      expect((await reads.overview(actor(), familyId)).videos).toBe("2");
    });
    it("stores member mutation and whitelisted management audit atomically", async () => {
      await members.updateMember({
        actor: actor(),
        familyId,
        targetMemberId: actor("member").memberId,
        mutation: { kind: "DISABLED", disabled: true },
      });
      await members.updateMember({
        actor: actor(),
        familyId,
        targetMemberId: actor("member").memberId,
        mutation: { kind: "DISABLED", disabled: false },
      });
      const first = await reads.audit(actor(), familyId, {
        source: "management",
        limit: 1,
      });
      expect(first.events).toHaveLength(1);
      expect(first.nextCursor).not.toBeNull();
      expect(JSON.stringify(first)).not.toMatch(
        /password|tokenHash|username|sessionId/u,
      );
      const next = await reads.audit(actor(), familyId, {
        source: "management",
        limit: 1,
        cursor: first.nextCursor!,
      });
      expect(next.events[0]!.id).not.toBe(first.events[0]!.id);
      await expect(
        reads.audit(actor(), familyId, {
          source: "media",
          limit: 1,
          cursor: first.nextCursor!,
        }),
      ).rejects.toMatchObject({ reason: "CONFLICT" });
      await expect(
        reads.audit(actor("admin"), familyId, {
          source: "management",
          limit: 1,
          cursor: first.nextCursor!,
        }),
      ).rejects.toMatchObject({ reason: "CONFLICT" });
    });
    it("an audit INSERT failure rolls back both member mutation and independent grant provision", async () => {
      const failingPool = new Proxy(db.pool, {
        get(target, key) {
          if (key === "getConnection")
            return async () => {
              const c = await target.getConnection();
              return new Proxy(c, {
                get(connection, property) {
                  const value = Reflect.get(connection, property);
                  if (typeof value !== "function") return value;
                  return (...args: unknown[]) => {
                    if (
                      (property === "execute" || property === "query") &&
                      typeof args[0] === "string" &&
                      args[0].includes("INSERT INTO admin_audit_events")
                    )
                      throw Error("SYNTHETIC_AUDIT_WRITE_FAILURE");
                    return Reflect.apply(value, connection, args);
                  };
                },
              });
            };
          const value = Reflect.get(target, key);
          return typeof value === "function" ? value.bind(target) : value;
        },
      }) as Pool;
      await expect(
        new MySqlPhase1CRepository(failingPool).updateMember({
          actor: actor(),
          familyId,
          targetMemberId: actor("member").memberId,
          mutation: { kind: "DISABLED", disabled: true },
        }),
      ).rejects.toThrow("SYNTHETIC_AUDIT_WRITE_FAILURE");
      const [member] = await fixturePool.query<RowDataPacket[]>(
        "SELECT disabled_at disabledAt FROM family_members WHERE family_id=? AND id=?",
        [familyId, actor("member").memberId],
      );
      expect(member[0]!.disabledAt).toBeNull();
      const operationId = randomUUID();
      await expect(
        new MySqlSystemControlRepository(failingPool).localGrant({
          familyId,
          userId: actor().userId,
          enabled: true,
          operationId,
        }),
      ).rejects.toThrow("SYNTHETIC_AUDIT_WRITE_FAILURE");
      await expect(
        control.resolveActor(actor()).then(
          () => "AUTHORIZED",
          (error: unknown) =>
            error instanceof SystemControlError ? error.reason : "UNCLASSIFIED",
        ),
      ).resolves.toBe("FORBIDDEN");
      const [events] = await fixturePool.query<RowDataPacket[]>(
        "SELECT id FROM admin_audit_events WHERE operation_id=?",
        [operationId],
      );
      expect(events).toHaveLength(0);
    });
    it("uses boot CAS and fresh exact revision proof, preserving large decimal counters", async () => {
      const [active] = await fixturePool.query<RowDataPacket[]>(
        "SELECT boot_id FROM admin_runtime_observations WHERE exited_at IS NULL",
      );
      expect(active).toHaveLength(0);
      const revision = (await control.readCurrent()).revision;
      const first = randomUUID(),
        second = randomUUID();
      bootIds.push(first, second);
      await control.runtimeRegister("API", first, revision);
      expect(await control.participantsReady(["API"], revision)).toBe(false);
      const beat = {
        revision,
        state: "IDLE" as const,
        reasonCode: "IDLE",
        success: false,
        completedUnits: "9007199254740993",
      };
      expect(await control.runtimeBeat("API", first, beat)).toBe(true);
      expect(await control.participantsReady(["API"], revision)).toBe(true);
      expect(
        await control.participantsReady(
          ["API"],
          (BigInt(revision) + 1n).toString(),
        ),
      ).toBe(false);
      await control.runtimeRegister("API", second, revision);
      expect(
        await control.runtimeBeat("API", first, {
          ...beat,
          state: "STOPPED",
          reasonCode: "STOPPED",
        }),
      ).toBe(false);
      expect(await control.runtimeBeat("API", second, beat)).toBe(true);
      await fixturePool.query(
        "UPDATE admin_runtime_observations SET received_at=DATE_SUB(CURRENT_TIMESTAMP(3),INTERVAL 16 SECOND) WHERE boot_id=?",
        [second],
      );
      expect(await control.participantsReady(["API"], revision)).toBe(false);
      const operationId = randomUUID();
      operations.push(operationId);
      await control.localGrant({
        familyId,
        userId: actor().userId,
        enabled: true,
        operationId,
      });
      const r = await reads.systemStatus(actor(), ["API"], storage),
        api = r.observations.workers.find((w) => w.role === "API")!;
      expect(api).toMatchObject({
        state: "UNKNOWN",
        completedUnits: "9007199254740993",
        lastSuccessfulAt: null,
        observation: { reasonCode: "STALE" },
      });
      expect(
        await control.runtimeBeat("API", second, {
          ...beat,
          state: "STOPPED",
          reasonCode: "STOPPED",
        }),
      ).toBe(true);
    });
  },
);
