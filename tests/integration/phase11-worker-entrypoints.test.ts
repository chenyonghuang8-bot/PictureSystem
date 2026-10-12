import { beforeAll, afterAll, describe, it, expect } from "vitest";
import { resolve } from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { syntheticGpsJpeg } from "../fixtures/location-jpeg.js";
import type { ResultSetHeader, RowDataPacket } from "mysql2/promise";
import {
  createDatabase,
  acquireCheckedConnection,
  assertMigrationReadiness,
  MySqlUploadRepository,
  MySqlUploadPipelineRepository,
  MySqlMediaRepository,
  MySqlJobRepository,
  MySqlDerivedAdmissionRepository,
  MySqlDerivedAssetFence,
  type Pool,
} from "../../packages/db/src/index.js";
import {
  ControlAdmissionError,
  renderUnverifiedCandidate,
} from "../../packages/storage/src/index.js";
import { loadLocationProjector } from "../../packages/media/src/index.js";
import { InProcessControlOwner } from "../helpers/in-process-control-owner.js";
import { MetadataJobDriver } from "../../apps/worker/src/metadata-driver.js";
import { ImageDerivativeDriver } from "../../apps/worker/src/image-derivative-driver.js";
import { PurgeProcessor } from "../../apps/worker/src/purge-processor.js";
import { UploadPipelineReconciler } from "../../apps/api/src/uploads/pipeline-reconciler.js";
import { StorageReconciler } from "../../apps/api/src/uploads/recovery.js";
import { UploadMutex } from "../../apps/api/src/uploads/mutex.js";
import { ImageDerivativeProcessor } from "../../apps/worker/src/image-derivative-processor.js";
if (!process.env.DATABASE_URL) throw Error("PHASE11_DEV_DB_REQUIRED");
describe.sequential(
  "Phase11 real worker/recovery entrypoint mode matrix",
  () => {
    const db = createDatabase(process.env.DATABASE_URL!);
    let owner: InProcessControlOwner;
    beforeAll(async () => {
      const c = await acquireCheckedConnection(db.pool);
      try {
        await assertMigrationReadiness(c);
      } finally {
        c.release();
      }
      owner = await InProcessControlOwner.start(db.pool, []);
    }, 30000);
    afterAll(async () => {
      try {
        if (owner) {
          const familyId = owner.fixture.syntheticIdentity.familyId;
          const c = await acquireCheckedConnection(db.pool);
          try {
            await c.beginTransaction();
            for (const table of [
              "derived_assets",
              "background_jobs",
              "media_items",
              "upload_sessions",
              "storage_objects",
            ])
              await c.query(`DELETE FROM ${table} WHERE family_id=?`, [
                familyId,
              ]);
            await c.commit();
          } catch (error) {
            await c.rollback();
            throw error;
          } finally {
            c.release();
          }
        }
        await owner?.close({ recheck: true });
      } finally {
        await db.pool.end();
      }
    }, 30000);
    for (const mode of ["READ_ONLY", "MAINTENANCE", "NORMAL"] as const)
      it(`${mode} guards every actual claim/recovery/cleanup entrypoint before driver SQL`, async () => {
        await owner.fixture.request(mode);
        await owner.withResources(async (r) => {
          if (
            r.capability.state !== "READ_WRITE" ||
            !r.reader ||
            !r.gate ||
            !r.store
          )
            throw Error("ACTUAL_OWNER_RESOURCES_REQUIRED");
          let calls = 0;
          const observed = new Proxy(db.pool, {
            get(target, key) {
              const v = Reflect.get(target, key);
              if (typeof v !== "function") return v;
              return (...args: unknown[]) => {
                if (["query", "execute", "getConnection"].includes(String(key)))
                  calls++;
                return Reflect.apply(v, target, args);
              };
            },
          }) as Pool;
          const metadata = new MetadataJobDriver(
            observed,
            r.reader,
            loadLocationProjector(resolve("resources/location/2026-10-03")),
            undefined,
            owner.admission,
          );
          const derived = new ImageDerivativeDriver(
            observed,
            { capability: r.capability, gate: r.gate, store: r.store },
            r.reader,
            owner.admission,
          );
          const purge = new PurgeProcessor(
            observed,
            r.capability.root,
            r.store,
            r.gate,
            undefined,
            owner.admission,
          );
          const pipeline = new UploadPipelineReconciler({
            repository: new MySqlUploadPipelineRepository(observed),
            media: new MySqlMediaRepository(observed),
            jobs: new MySqlJobRepository(observed),
            acquire: UploadPipelineReconciler.acquire(r.capability.root),
            admission: owner.admission,
          });
          const recovery = new StorageReconciler(
            new MySqlUploadRepository(observed),
            r.capability,
            new UploadMutex(),
          );
          const cases: [string, () => Promise<unknown>][] = [
            ["metadata claim", () => metadata.runNext()],
            ["metadata expired lease", () => metadata.recoverExpired()],
            ["derived claim/render/publish", () => derived.runNext()],
            ["derived expired lease", () => derived.recoverExpired()],
            ["purge claim/quarantine/unlink/accounting", () => purge.runNext()],
            [
              "canonical reconciliation",
              () =>
                pipeline.reconcile({
                  uploadId: "1",
                  familyId: owner.fixture.syntheticIdentity.familyId,
                  expectedStorageObjectId: "1",
                  expectedSha256Hex: "a".repeat(64),
                  expectedByteSize: "1",
                }),
            ],
            // Same explicit production CLI admission wrapper; borrows the sole owner.
            [
              "original recovery",
              () =>
                owner.admission.run("MEDIA_WRITE", () =>
                  recovery.run({ mode: "recover", scope: "startup" }),
                ),
            ],
            [
              "terminal staging cleanup",
              () =>
                owner.admission.run("MEDIA_WRITE", () =>
                  recovery.run({ mode: "cleanup-staging", scope: "global" }),
                ),
            ],
          ];
          for (const [name, run] of cases) {
            calls = 0;
            if (mode !== "NORMAL") {
              await expect(run(), name).rejects.toBeInstanceOf(
                ControlAdmissionError,
              );
              expect(calls, name).toBe(0);
            } else {
              await run();
              expect(calls, name).toBeGreaterThan(0);
            }
          }
        });
      }, 30000);
    for (const boundary of [
      "PUBLISHING_COMMITTED",
      "FINAL_PUBLISHED",
      "BEFORE_READY",
    ] as const)
      it(`actual derivative ${boundary} remains in its admitted unit until native publish and READY settle`, async () => {
        await owner.fixture.request("NORMAL");
        await owner.withResources(async (r) => {
          if (
            r.capability.state !== "READ_WRITE" ||
            !r.reader ||
            !r.gate ||
            !r.store
          )
            throw Error("ACTUAL_OWNER_RESOURCES_REQUIRED");
          const root = r.capability.root;
          const familyId = owner.fixture.syntheticIdentity.familyId;
          const bytes = Buffer.concat([
            syntheticGpsJpeg(),
            Buffer.from(boundary),
          ]);
          const digest = createHash("sha256").update(bytes).digest();
          const publicId = randomBytes(16).toString("hex");
          await owner.admission.run("MEDIA_WRITE", async () => {
            root.createUploadPayload(familyId, publicId, bytes);
            root.publishOriginal({
              familyId,
              uploadId: publicId,
              sha256Hex: digest.toString("hex"),
              byteSize: String(bytes.length),
            });
          });
          const c = await acquireCheckedConnection(db.pool);
          let uploadId: string;
          try {
            const [object] = await c.query<ResultSetHeader>(
              "INSERT INTO storage_objects (family_id,sha256,byte_size,key_version,state,durable_at,verified_at) VALUES (?,?,?,1,'AVAILABLE',CURRENT_TIMESTAMP(3),CURRENT_TIMESTAMP(3))",
              [familyId, digest, bytes.length],
            );
            const [upload] = await c.query<ResultSetHeader>(
              "INSERT INTO upload_sessions (public_id,family_id,created_by_member_id,original_filename,declared_size,committed_offset,state,computed_sha256,finalize_started_at,storage_object_id,completed_at,staging_cleaned_at,expires_at) VALUES (?,?,?,'synthetic.jpg',?,?,'COMPLETE',?,CURRENT_TIMESTAMP(3),?,CURRENT_TIMESTAMP(3),CURRENT_TIMESTAMP(3),DATE_ADD(CURRENT_TIMESTAMP(3),INTERVAL 1 DAY))",
              [
                Buffer.from(publicId, "hex"),
                familyId,
                owner.fixture.syntheticIdentity.memberId,
                bytes.length,
                bytes.length,
                digest,
                String(object.insertId),
              ],
            );
            uploadId = String(upload.insertId);
          } finally {
            c.release();
          }
          const media = await new MySqlMediaRepository(
            db.pool,
          ).createOrGetCanonicalMedia({ familyId, uploadId });
          await db.pool.query(
            "UPDATE media_items SET metadata_generation=generation,media_type='IMAGE',detected_mime='image/jpeg' WHERE family_id=? AND id=?",
            [familyId, media.media.id],
          );
          const jobs = new MySqlJobRepository(db.pool);
          await jobs.enqueue({
            familyId,
            mediaId: media.media.id,
            generation: 1n,
            recipeId: 1,
            jobType: "IMAGE_DERIVATIVES",
          });
          const fence = new MySqlDerivedAssetFence(db.pool);
          let restriction: Promise<unknown> | undefined;
          let entered = false;
          const pause = async () => {
            if (entered) return;
            entered = true;
            restriction = owner.fixture.request("READ_ONLY");
            await expect
              .poll(
                async () =>
                  (await owner.fixture.repository.readCurrent())
                    .transitionState,
              )
              .toBe("DRAINING");
            await expect(
              owner.admission.run("MEDIA_WRITE", async () => true),
            ).rejects.toBeInstanceOf(ControlAdmissionError);
            expect(
              (await owner.fixture.repository.readCurrent()).transitionState,
            ).toBe("DRAINING");
          };
          if (boundary === "PUBLISHING_COMMITTED") {
            const actual = fence.markPublishing.bind(fence);
            fence.markPublishing = async (...args) => {
              const result = await actual(...args);
              if (result === "COMMITTED") await pause();
              return result;
            };
          } else if (boundary === "FINAL_PUBLISHED") {
            const actual = fence.confirmPublishing.bind(fence);
            fence.confirmPublishing = async (...args) => {
              await pause();
              return actual(...args);
            };
          } else {
            const actual = fence.commitSucceeded.bind(fence);
            fence.commitSucceeded = async (...args) => {
              await pause();
              return actual(...args);
            };
          }
          const processor = new ImageDerivativeProcessor(
            jobs,
            new MySqlDerivedAdmissionRepository(db.pool),
            fence,
            { capability: r.capability, gate: r.gate, store: r.store },
            (input) =>
              r.reader!.withVerifiedOriginal(input, (handle) =>
                renderUnverifiedCandidate(handle, input.kind),
              ),
          );
          const driver = new ImageDerivativeDriver(
            db.pool,
            undefined,
            undefined,
            owner.admission,
            (operation) => operation(processor),
          );
          expect(await driver.runNext()).toBe(true);
          expect(entered).toBe(true);
          await restriction;
          const [rows] = await db.pool.query<RowDataPacket[]>(
            "SELECT processing_state state FROM media_items WHERE family_id=? AND id=?",
            [familyId, media.media.id],
          );
          expect(rows[0]?.state).toBe("READY");
          expect(
            (await owner.fixture.repository.readCurrent()).transitionState,
          ).toBe("STABLE");
          const original = await r.reader.withVerifiedOriginal(
            {
              familyId,
              sha256Hex: digest.toString("hex"),
              byteSize: String(bytes.length),
            },
            async (handle) => handle,
          );
          expect(original).toBeDefined();
        });
      }, 45000);
  },
);
