import { readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { freshStorageRootPath } from "../fixtures/fresh-storage-root.js";
import { syntheticGpsJpeg } from "../fixtures/location-jpeg.js";
import { loadLocationProjector } from "../../packages/media/src/index.js";
import {
  StorageRoot,
  OriginalReader,
} from "../../packages/storage/src/index.js";
import { MetadataJobDriver } from "../../apps/worker/src/metadata-driver.js";
import { createHash, randomBytes, randomUUID } from "node:crypto";

import type { NormalizedMetadataResult } from "@family-album/media";
import type { ResultSetHeader, RowDataPacket } from "mysql2/promise";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import {
  assertMigrationReadiness,
  createDatabase,
  type LeaseFence,
  MySqlJobRepository,
  MySqlMediaRepository,
  MySqlMetadataRepository,
  MySqlLocationProjectionRepository,
  CommitOutcomeUnknownError,
} from "../../packages/db/src/index.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("PHASE4D2_DEV_DATABASE_URL_REQUIRED");

describe.sequential(
  "Phase8 projection atomic metadata and actual native driver",
  () => {
    const database = createDatabase(databaseUrl);
    const jobs = new MySqlJobRepository(database.pool, { random: () => 0 });
    const media = new MySqlMediaRepository(database.pool);
    const projector = loadLocationProjector(
      resolve("resources/location/2026-10-03"),
    );
    const metadata = new MySqlMetadataRepository(database.pool, {
      random: () => 0,
      locationProjector: projector,
    });
    const suffix = randomUUID().replaceAll("-", "");
    let familyId = "";
    let crossFamilyId = "";
    let memberId = "";

    beforeAll(async () => {
      const connection = await database.pool.getConnection();
      try {
        await connection.query("SET SESSION time_zone = '+00:00'");
        const [preflight] = await connection.query<RowDataPacket[]>(
          `SELECT DATABASE() AS db,VERSION() AS mysqlVersion,CURRENT_USER() AS account,
          @@GLOBAL.innodb_native_foreign_keys AS nativeFk,
          @@SESSION.foreign_key_checks AS foreignKeyChecks`,
        );
        const row = preflight[0];
        if (
          !row ||
          row.db !== "family_album_dev" ||
          !String(row.mysqlVersion).startsWith("9.7.2") ||
          String(row.account).split("@")[0]?.toLowerCase() === "root" ||
          Number(row.nativeFk) !== 1 ||
          Number(row.foreignKeyChecks) !== 1
        ) {
          throw new Error("PHASE4D2_DEV_PREFLIGHT_FAILED");
        }
        await assertMigrationReadiness(connection);
        await connection.beginTransaction();
        const [family] = await connection.query<ResultSetHeader>(
          "INSERT INTO families (name) VALUES (?)",
          [`Phase 4D2 synthetic ${suffix}`],
        );
        familyId = String(family.insertId);
        const [cross] = await connection.query<ResultSetHeader>(
          "INSERT INTO families (name) VALUES (?)",
          [`Phase 4D2 cross synthetic ${suffix}`],
        );
        crossFamilyId = String(cross.insertId);
        const username = `phase4d2_${suffix}`;
        const [user] = await connection.query<ResultSetHeader>(
          `INSERT INTO users
          (username,username_normalized,password_hash,display_name,password_changed_at)
         VALUES (?,?,?,?,CURRENT_TIMESTAMP(3))`,
          [username, Buffer.from(username), "synthetic-not-used", "Phase 4D2"],
        );
        const [member] = await connection.query<ResultSetHeader>(
          "INSERT INTO family_members (family_id,user_id,role) VALUES (?,?,'MEMBER')",
          [familyId, String(user.insertId)],
        );
        memberId = String(member.insertId);
        await connection.commit();
      } catch (error) {
        await connection.rollback();
        throw error;
      } finally {
        connection.release();
      }
    });

    afterEach(async () => {
      if (!familyId) return;
      await database.pool.query(
        `UPDATE background_jobs SET state='CANCELLED',worker_id=NULL,
        locked_at=NULL,heartbeat_at=NULL,locked_until=NULL,last_failure_code=NULL,
        finished_at=CURRENT_TIMESTAMP(3)
       WHERE family_id=? AND state NOT IN ('SUCCEEDED','FAILED','CANCELLED')`,
        [familyId],
      );
    });

    afterAll(async () => {
      const connection = await database.pool.getConnection();
      try {
        await connection.query("SET SESSION time_zone = '+00:00'");
        await connection.beginTransaction();
        await connection.query(
          "DELETE FROM background_jobs WHERE family_id=?",
          [familyId],
        );
        await connection.query(
          "DELETE FROM media_location_projections WHERE family_id=?",
          [familyId],
        );
        await connection.query("DELETE FROM media_items WHERE family_id=?", [
          familyId,
        ]);
        await connection.query(
          "DELETE FROM upload_sessions WHERE family_id=?",
          [familyId],
        );
        await connection.query(
          "DELETE FROM storage_objects WHERE family_id=?",
          [familyId],
        );
        await connection.query(
          "DELETE FROM family_members WHERE family_id IN (?,?)",
          [familyId, crossFamilyId],
        );
        await connection.query("DELETE FROM users WHERE username=?", [
          `phase4d2_${suffix}`,
        ]);
        await connection.query("DELETE FROM families WHERE id IN (?,?)", [
          familyId,
          crossFamilyId,
        ]);
        await connection.commit();
        const [remaining] = await connection.query<RowDataPacket[]>(
          `SELECT
          (SELECT COUNT(*) FROM background_jobs WHERE family_id=?) +
          (SELECT COUNT(*) FROM media_items WHERE family_id=?) +
          (SELECT COUNT(*) FROM upload_sessions WHERE family_id=?) +
          (SELECT COUNT(*) FROM storage_objects WHERE family_id=?) AS count`,
          [familyId, familyId, familyId, familyId],
        );
        expect(Number(remaining[0]?.count ?? 1)).toBe(0);
      } catch (error) {
        await connection.rollback();
        throw error;
      } finally {
        connection.release();
        await database.pool.end();
      }
    });

    async function createClaimed(
      label: string,
      generation = 1n,
      fixture?: Buffer,
    ) {
      const sha256 = createHash("sha256")
        .update(fixture ?? `${suffix}:${label}`)
        .digest();
      const bytes = BigInt(fixture?.length ?? 4096 + label.length);
      const [object] = await database.pool.query<ResultSetHeader>(
        `INSERT INTO storage_objects
        (family_id,sha256,byte_size,key_version,state,durable_at,verified_at)
       VALUES (?,?,?,1,'AVAILABLE',CURRENT_TIMESTAMP(3),CURRENT_TIMESTAMP(3))`,
        [familyId, sha256, bytes.toString()],
      );
      const storageObjectId = String(object.insertId);
      const [upload] = await database.pool.query<ResultSetHeader>(
        `INSERT INTO upload_sessions
        (public_id,family_id,created_by_member_id,original_filename,
         declared_size,committed_offset,state,computed_sha256,
         finalize_started_at,storage_object_id,completed_at,expires_at)
       VALUES (?,?,?,'synthetic.bin',?,?,'COMPLETE',?,CURRENT_TIMESTAMP(3),?,
         CURRENT_TIMESTAMP(3),DATE_ADD(CURRENT_TIMESTAMP(3),INTERVAL 1 DAY))`,
        [
          randomBytes(16),
          familyId,
          memberId,
          bytes.toString(),
          bytes.toString(),
          sha256,
          storageObjectId,
        ],
      );
      const item = (
        await media.createOrGetCanonicalMedia({
          familyId,
          uploadId: String(upload.insertId),
        })
      ).media;
      if (generation !== 1n) {
        await database.pool.query(
          "UPDATE media_items SET generation=?,processing_state='PENDING' WHERE id=?",
          [generation.toString(), item.id],
        );
      }
      const claimed = await insertClaimedJob(item.id, generation);
      const preparation = await metadata.prepare(claimed.fence);
      if (!preparation) throw new Error("expected current synthetic lease");
      return {
        item,
        uploadId: String(upload.insertId),
        storageObjectId,
        claimed,
        fence: claimed.fence,
        preparation,
      };
    }

    async function insertClaimedJob(mediaId: string, generation: bigint) {
      const workerId = MySqlJobRepository.createWorkerIdentity();
      const [inserted] = await database.pool.query<ResultSetHeader>(
        `INSERT INTO background_jobs
        (family_id,media_id,generation,recipe_id,job_type,state,attempts,
         available_at,locked_at,heartbeat_at,locked_until,worker_id,lease_epoch)
       VALUES (?,?,?,1,'MEDIA_PROBE','RUNNING',1,CURRENT_TIMESTAMP(3),
         CURRENT_TIMESTAMP(3),CURRENT_TIMESTAMP(3),
         DATE_ADD(CURRENT_TIMESTAMP(3),INTERVAL 90 SECOND),?,1)`,
        [familyId, mediaId, generation.toString(), workerId],
      );
      const id = String(inserted.insertId);
      return {
        id,
        lifecycleRevision: 1n,
        leaseEpoch: 1n,
        fence: {
          lifecycleRevision: 1n,
          familyId,
          mediaId,
          jobId: id,
          generation,
          workerId,
          leaseEpoch: 1n,
        } satisfies LeaseFence,
      };
    }

    async function reclaimDirect(input: {
      jobId: string;
      mediaId: string;
      generation: bigint;
      expectedEpoch: bigint;
    }) {
      const workerId = MySqlJobRepository.createWorkerIdentity();
      const [changed] = await database.pool.query<ResultSetHeader>(
        `UPDATE background_jobs SET state='RUNNING',attempts=attempts+1,
        worker_id=?,lease_epoch=lease_epoch+1,locked_at=CURRENT_TIMESTAMP(3),
        heartbeat_at=CURRENT_TIMESTAMP(3),
        locked_until=DATE_ADD(CURRENT_TIMESTAMP(3),INTERVAL 90 SECOND),
        last_failure_code=NULL,finished_at=NULL,updated_at=CURRENT_TIMESTAMP(3)
       WHERE id=? AND family_id=? AND media_id=? AND generation=?
         AND state='RETRY_WAIT' AND lease_epoch=?`,
        [
          workerId,
          input.jobId,
          familyId,
          input.mediaId,
          input.generation.toString(),
          input.expectedEpoch.toString(),
        ],
      );
      expect(changed.affectedRows).toBe(1);
      return {
        familyId,
        mediaId: input.mediaId,
        jobId: input.jobId,
        generation: input.generation,
        workerId,
        lifecycleRevision: 1n,
        leaseEpoch: input.expectedEpoch + 1n,
      } satisfies LeaseFence;
    }

    async function expire(jobId: string) {
      await database.pool.query(
        `UPDATE background_jobs SET
        locked_at=DATE_SUB(CURRENT_TIMESTAMP(3),INTERVAL 120 SECOND),
        heartbeat_at=DATE_SUB(CURRENT_TIMESTAMP(3),INTERVAL 120 SECOND),
        locked_until=DATE_SUB(CURRENT_TIMESTAMP(3),INTERVAL 1 SECOND)
       WHERE id=? AND state='RUNNING'`,
        [jobId],
      );
    }

    async function projectionRows(id: string) {
      const [rows] = await database.pool.query<RowDataPacket[]>(
        "SELECT h3_cell cell,country_code country,CAST(generation AS CHAR) generation FROM media_location_projections WHERE family_id=? AND media_id=?",
        [familyId, id],
      );
      return rows;
    }
    const gps = imageResult({
      gpsLatitude: "37.780000",
      gpsLongitude: "-122.420000",
    });
    it("commits current metadata/projection/job together and clears projections with empty snapshots", async () => {
      const f = await createClaimed("projection");
      expect(
        await metadata.persistResult(f.fence, f.preparation, gps),
      ).toMatchObject({ affectedRows: 1, jobState: "SUCCEEDED" });
      expect(await projectionRows(f.item.id)).toEqual([
        expect.objectContaining({ country: "US", generation: "1" }),
      ]);
      await database.pool.query(
        "UPDATE background_jobs SET state='RUNNING',lease_epoch=2,finished_at=NULL,locked_at=CURRENT_TIMESTAMP(3),heartbeat_at=CURRENT_TIMESTAMP(3),locked_until=DATE_ADD(CURRENT_TIMESTAMP(3),INTERVAL 90 SECOND),worker_id=? WHERE id=?",
        [f.fence.workerId, f.fence.jobId],
      );
      const next = { fence: { ...f.fence, leaseEpoch: 2n } },
        preparation = await metadata.prepare(next.fence);
      expect(preparation).not.toBeNull();
      await metadata.persistOperationalFailure(
        next.fence,
        preparation!,
        "CAPABILITY_DISABLED",
      );
      expect(await projectionRows(f.item.id)).toEqual([]);
      const [snapshot] = await database.pool.query<RowDataPacket[]>(
        "SELECT gps_latitude gps FROM media_items WHERE id=?",
        [f.item.id],
      );
      expect(snapshot[0]!.gps).toBeNull();
    });
    it("never writes projections from expired, reclaimed, or old generation fences", async () => {
      for (const kind of ["expiry", "epoch", "generation"]) {
        const f = await createClaimed(kind);
        if (kind === "expiry") await expire(f.fence.jobId);
        else if (kind === "epoch") {
          await expire(f.fence.jobId);
          await jobs.recoverExpiredLease({
            familyId,
            mediaId: f.item.id,
            jobId: f.fence.jobId,
            generation: 1n,
          });
          await reclaimDirect({
            jobId: f.fence.jobId,
            mediaId: f.item.id,
            generation: 1n,
            expectedEpoch: 1n,
          });
        } else
          await database.pool.query(
            "UPDATE media_items SET generation=2 WHERE id=?",
            [f.item.id],
          );
        expect(
          await metadata.persistResult(f.fence, f.preparation, gps),
        ).toEqual({ affectedRows: 0 });
        expect(await projectionRows(f.item.id)).toEqual([]);
      }
    });
    it("rolls back metadata and job when projection insert validation fails", async () => {
      const f = await createClaimed("write-failure");
      const broken = loadLocationProjector(
        resolve("resources/location/2026-10-03"),
      );
      broken.project = () => ({
        ...projector.project("37.78", "-122.42"),
        policyVersion: 0,
      });
      const repository = new MySqlMetadataRepository(database.pool, {
        locationProjector: broken,
      });
      await expect(
        repository.persistResult(f.fence, f.preparation, gps),
      ).rejects.toThrow("LOCATION_PROJECTION_INVALID");
      expect(await projectionRows(f.item.id)).toEqual([]);
      const [rows] = await database.pool.query<RowDataPacket[]>(
        "SELECT m.metadata_generation metadataGeneration,j.state FROM media_items m JOIN background_jobs j ON j.media_id=m.id WHERE j.id=?",
        [f.fence.jobId],
      );
      expect(rows[0]).toMatchObject({
        metadataGeneration: null,
        state: "RUNNING",
      });
    });
    it("defers unexpected compute failure without calling it NO_GPS or failing valid media", async () => {
      const f = await createClaimed("compute-failure");
      let failures = 0;
      const broken = loadLocationProjector(
        resolve("resources/location/2026-10-03"),
      );
      broken.project = () => {
        throw new Error("synthetic");
      };
      const repository = new MySqlMetadataRepository(database.pool, {
        locationProjector: broken,
        onProjectionFailure: () => {
          ++failures;
        },
      });
      expect(
        await repository.persistResult(f.fence, f.preparation, gps),
      ).toMatchObject({ affectedRows: 1, jobState: "SUCCEEDED" });
      expect(failures).toBe(1);
      expect(await projectionRows(f.item.id)).toEqual([]);
      const [rows] = await database.pool.query<RowDataPacket[]>(
        "SELECT gps_latitude gps FROM media_items WHERE id=?",
        [f.item.id],
      );
      expect(rows[0]!.gps).toBe("37.780000");
    });
    it("serializes backfill and same-generation metadata replacement in both real lock acquisition orders", async () => {
      for (const first of ["backfill", "metadata"] as const) {
        const f = await createClaimed(`barrier-${first}`);
        await database.pool.query(
          "UPDATE media_items SET metadata_generation=generation,gps_latitude='37.780000',gps_longitude='-122.420000' WHERE id=?",
          [f.item.id],
        );
        const backfill = new MySqlLocationProjectionRepository(
          database.pool,
          projector,
        );
        const token = (await backfill.scan(familyId, 100)).find(
          (t) => t.mediaId === f.item.id,
        )!;
        let acquired!: () => void, release!: () => void;
        const locked = new Promise<void>((r) => {
            acquired = r;
          }),
          barrier = new Promise<void>((r) => {
            release = r;
          });
        let waited = false;
        const controlledPool = new Proxy(database.pool, {
          get(pool, key) {
            if (key === "getConnection")
              return async () => {
                const c = await pool.getConnection();
                return new Proxy(c, {
                  get(connection, method) {
                    if (method === "query")
                      return async (...args: Parameters<typeof c.query>) => {
                        const result = await c.query(...args);
                        if (
                          !waited &&
                          typeof args[0] === "string" &&
                          args[0].includes("FROM media_items") &&
                          args[0].includes("FOR UPDATE")
                        ) {
                          waited = true;
                          acquired();
                          await barrier;
                        }
                        return result;
                      };
                    const value = Reflect.get(connection, method);
                    return typeof value === "function"
                      ? value.bind(connection)
                      : value;
                  },
                });
              };
            const value = Reflect.get(pool, key);
            return typeof value === "function" ? value.bind(pool) : value;
          },
        });
        const replacement = imageResult({
          gpsLatitude: "48.856600",
          gpsLongitude: "2.352200",
        });
        const writer =
          first === "backfill"
            ? new MySqlLocationProjectionRepository(
                controlledPool,
                projector,
              ).apply(token)
            : new MySqlMetadataRepository(controlledPool, {
                locationProjector: projector,
              }).persistResult(f.fence, f.preparation, replacement);
        let second: Promise<unknown> | undefined;
        try {
          await locked;
          second =
            first === "backfill"
              ? metadata.persistResult(f.fence, f.preparation, replacement)
              : backfill.apply(token);
          release();
          await writer;
          const outcome = await second;
          if (first === "metadata") expect(outcome).toBe("STALE");
          else expect(outcome).toMatchObject({ jobState: "SUCCEEDED" });
          expect(await projectionRows(f.item.id)).toEqual([
            expect.objectContaining({ country: "FR", generation: "1" }),
          ]);
        } finally {
          release();
          await Promise.allSettled([writer, second]);
        }
      }
    }, 30000);
    it("fences backfill against generation, trash/restore and lease takeover in both actual SQL lock orders", async () => {
      for (const change of ["generation", "trash-restore", "lease"] as const)
        for (const first of ["backfill", "mutation"] as const) {
          const f = await createClaimed(`fence-${change}-${first}`);
          // This is a focused locking/CAS fixture, not upload runtime evidence.
          await database.pool.query(
            "UPDATE media_items SET metadata_generation=generation,gps_latitude='37.780000',gps_longitude='-122.420000' WHERE id=?",
            [f.item.id],
          );
          const backfill = new MySqlLocationProjectionRepository(
              database.pool,
              projector,
            ),
            token = (await backfill.scan(familyId, 100)).find(
              (t) => t.mediaId === f.item.id,
            )!;
          let enter!: () => void, release!: () => void;
          const locked = new Promise<void>((r) => {
              enter = r;
            }),
            resume = new Promise<void>((r) => {
              release = r;
            });
          let pause = true;
          const controlledPool = new Proxy(database.pool, {
            get(pool, key) {
              if (key === "getConnection")
                return async () => {
                  const c = await pool.getConnection();
                  return new Proxy(c, {
                    get(connection, method) {
                      if (method === "query")
                        return async (...args: Parameters<typeof c.query>) => {
                          const result = await c.query(...args);
                          if (
                            pause &&
                            typeof args[0] === "string" &&
                            args[0].includes("FROM media_items") &&
                            args[0].includes("FOR UPDATE")
                          ) {
                            pause = false;
                            enter();
                            await resume;
                          }
                          return result;
                        };
                      const value = Reflect.get(connection, method);
                      return typeof value === "function"
                        ? value.bind(connection)
                        : value;
                    },
                  });
                };
              const value = Reflect.get(pool, key);
              return typeof value === "function" ? value.bind(pool) : value;
            },
          });
          const mutate = async () => {
            const c = await database.pool.getConnection();
            try {
              await c.beginTransaction();
              await c.query("SELECT id FROM families WHERE id=? FOR SHARE", [
                familyId,
              ]);
              await c.query(
                "SELECT id FROM storage_objects WHERE family_id=? AND id=? FOR SHARE",
                [familyId, token.storageObjectId],
              );
              await c.query(
                "SELECT id FROM media_items WHERE family_id=? AND id=? FOR UPDATE",
                [familyId, f.item.id],
              );
              if (first === "mutation") {
                enter();
                await resume;
              }
              if (change === "generation")
                await c.query(
                  "UPDATE media_items SET generation=generation+1,metadata_generation=metadata_generation+1 WHERE id=?",
                  [f.item.id],
                );
              else if (change === "trash-restore") {
                await c.query(
                  "UPDATE media_items SET trashed_at=UTC_TIMESTAMP(3),trashed_by_member_id=?,purge_after=UTC_TIMESTAMP(3)+INTERVAL 30 DAY,lifecycle_revision=lifecycle_revision+1 WHERE id=?",
                  [memberId, f.item.id],
                );
                await c.query(
                  "UPDATE media_items SET trashed_at=NULL,trashed_by_member_id=NULL,purge_after=NULL,lifecycle_revision=lifecycle_revision+1 WHERE id=?",
                  [f.item.id],
                );
              } else
                await c.query(
                  "UPDATE background_jobs SET lease_epoch=lease_epoch+1,worker_id=? WHERE family_id=? AND id=?",
                  [
                    MySqlJobRepository.createWorkerIdentity(),
                    familyId,
                    f.fence.jobId,
                  ],
                );
              await c.commit();
            } catch (error) {
              await c.rollback();
              throw error;
            } finally {
              c.release();
            }
          };
          const active =
            first === "backfill"
              ? new MySqlLocationProjectionRepository(
                  controlledPool,
                  projector,
                ).apply(token)
              : mutate();
          let second: Promise<unknown> | undefined;
          try {
            await locked;
            second = first === "backfill" ? mutate() : backfill.apply(token);
            let settled = false;
            void second.then(() => {
              settled = true;
            });
            await new Promise((r) => setTimeout(r, 50));
            expect(settled).toBe(false);
            release();
            const [a, b] = await Promise.all([active, second]);
            const outcome = first === "backfill" ? a : b;
            expect(outcome).toBe(
              first === "mutation" && change !== "lease" ? "STALE" : "INSERTED",
            );
            // The old metadata worker may never overwrite a surviving backfill
            // after any generation/lifecycle/lease fence change.
            expect(
              await metadata.persistResult(
                f.fence,
                f.preparation,
                imageResult({
                  gpsLatitude: "48.856600",
                  gpsLongitude: "2.352200",
                }),
              ),
            ).toEqual({ affectedRows: 0 });
            if (change === "lease")
              expect(await projectionRows(f.item.id)).toEqual([
                expect.objectContaining({ country: "US", generation: "1" }),
              ]);
            else expect(await backfill.apply(token)).toBe("STALE");
          } finally {
            release();
            await Promise.allSettled([active, second]);
          }
        }
    }, 30000);
    it("recovers projection commit-response loss from fresh scans without replaying committed writes", async () => {
      for (const committed of [false, true]) {
        const f = await createClaimed(`projection-unknown-${committed}`);
        await database.pool.query(
          "UPDATE media_items SET metadata_generation=generation,gps_latitude='37.780000',gps_longitude='-122.420000' WHERE id=?",
          [f.item.id],
        );
        const fresh = new MySqlLocationProjectionRepository(
            database.pool,
            projector,
          ),
          token = (await fresh.scan(familyId, 100)).find(
            (t) => t.mediaId === f.item.id,
          )!;
        const faultPool = new Proxy(database.pool, {
          get(pool, key) {
            if (key === "getConnection")
              return async () => {
                const c = await pool.getConnection();
                return new Proxy(c, {
                  get(connection, method) {
                    if (method === "commit")
                      return async () => {
                        if (committed) await c.commit();
                        else await c.rollback();
                        throw new Error("SYNTHETIC_LOST_COMMIT_RESPONSE");
                      };
                    const value = Reflect.get(connection, method);
                    return typeof value === "function"
                      ? value.bind(connection)
                      : value;
                  },
                });
              };
            const value = Reflect.get(pool, key);
            return typeof value === "function" ? value.bind(pool) : value;
          },
        });
        await expect(
          new MySqlLocationProjectionRepository(faultPool, projector).apply(
            token,
          ),
        ).rejects.toBeInstanceOf(CommitOutcomeUnknownError);
        const rediscovered = (await fresh.scan(familyId, 100)).filter(
          (t) => t.mediaId === f.item.id,
        );
        expect(rediscovered).toHaveLength(committed ? 0 : 1);
        if (!committed)
          expect(await fresh.apply(rediscovered[0]!)).toBe("INSERTED");
        expect(await projectionRows(f.item.id)).toHaveLength(1);
      }
    });
    it("drives an actual queued MEDIA_PROBE through the native parser and leaves Original bytes unchanged", async () => {
      const bytes = syntheticGpsJpeg(),
        f = await createClaimed("real-driver", 1n, bytes),
        rootPath = freshStorageRootPath("p8-native-");
      const writer = StorageRoot.open(rootPath, { initialize: true });
      let reader: OriginalReader | undefined;
      try {
        const sha256Hex = createHash("sha256").update(bytes).digest("hex"),
          uploadId = randomBytes(16).toString("hex");
        writer.createUploadPayload(familyId, uploadId, bytes);
        const published = writer.publishOriginal({
          familyId,
          uploadId,
          sha256Hex,
          byteSize: String(bytes.length),
        });
        const path = join(rootPath, published.relativePath),
          before = readFileSync(path);
        reader = OriginalReader.open({
          mediaRoot: rootPath,
          expectedMarkerId: writer.markerId,
        });
        await database.pool.query(
          "UPDATE background_jobs SET state='QUEUED',locked_at=NULL,heartbeat_at=NULL,locked_until=NULL,worker_id=NULL,attempts=0 WHERE id=?",
          [f.fence.jobId],
        );
        const driver = new MetadataJobDriver(database.pool, reader, projector);
        expect(await driver.runNext()).toBe(true);
        expect(await projectionRows(f.item.id)).toEqual([
          expect.objectContaining({ country: "US", generation: "1" }),
        ]);
        expect(readFileSync(path)).toEqual(before);
        const [jobs] = await database.pool.query<RowDataPacket[]>(
          "SELECT job_type type,state FROM background_jobs WHERE family_id=? AND media_id=? ORDER BY id",
          [familyId, f.item.id],
        );
        expect(jobs).toEqual([
          expect.objectContaining({ type: "MEDIA_PROBE", state: "SUCCEEDED" }),
          expect.objectContaining({
            type: "IMAGE_DERIVATIVES",
            state: "QUEUED",
          }),
        ]);
      } finally {
        reader?.close();
        writer.close();
        rmSync(rootPath, { recursive: true, force: true });
      }
    }, 30000);
  },
);

function imageResult(
  overrides: Partial<NormalizedMetadataResult> = {},
): NormalizedMetadataResult {
  return {
    parserStatus: "SUCCESS",
    detectedMediaType: "IMAGE",
    detectedMime: "image/jpeg",
    container: "JPEG",
    rawWidth: 64,
    rawHeight: 48,
    displayWidth: 64,
    displayHeight: 48,
    orientation: 1,
    isAnimated: false,
    capturedLocalAt: null,
    capturedAtUtc: null,
    captureOffsetMinutes: null,
    captureTimezoneKnown: false,
    captureTimeSource: "NONE",
    captureTimeStatus: "ABSENT",
    gpsLatitude: null,
    gpsLongitude: null,
    cameraMake: null,
    cameraModel: null,
    durationMs: null,
    rotationDegrees: null,
    videoCodec: null,
    warnings: [],
    ...overrides,
  };
}
