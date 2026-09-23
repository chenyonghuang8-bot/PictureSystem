import { spawnSync } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  chmodSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
  existsSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { deflateSync } from "node:zlib";

import type { ResultSetHeader, RowDataPacket } from "mysql2/promise";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  admitDerivedReservation,
  createOwnedDerivedTemp,
} from "../../apps/worker/src/derived-admission.js";
import {
  assertMigrationReadiness,
  createDatabase,
  MySqlDerivedAdmissionRepository,
  MySqlMediaRepository,
  type DerivedReservationIdentity,
} from "../../packages/db/dist/index.js";
import {
  CapacityGate,
  DerivedStore,
  buildOriginalPath,
  OriginalReader,
  StorageRoot,
  renderUnverifiedCandidate,
  type StorageCapability,
} from "../../packages/storage/src/index.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("PHASE4D3A2B_DEV_DATABASE_URL_REQUIRED");

const BOX = { THUMBNAIL: 480, PREVIEW: 2560 } as const;

function expectedFit(
  rawWidth: number,
  rawHeight: number,
  orientation: number,
  kind: keyof typeof BOX,
) {
  const box = BOX[kind];
  const swapped = orientation >= 5;
  const displayWidth = swapped ? rawHeight : rawWidth;
  const displayHeight = swapped ? rawWidth : rawHeight;
  let width = displayWidth;
  let height = displayHeight;
  if (displayWidth > box || displayHeight > box) {
    if (displayWidth >= displayHeight) {
      width = box;
      height = Math.trunc((displayHeight * box) / displayWidth);
    } else {
      height = box;
      width = Math.trunc((displayWidth * box) / displayHeight);
    }
    if (width < 1) width = 1;
    if (height < 1) height = 1;
  }
  return { width, height };
}

function syntheticPng(
  width: number,
  height: number,
  alphaAtOrigin = false,
): Buffer {
  const crc32 = (bytes: Buffer) => {
    let crc = 0xffffffff;
    for (const byte of bytes) {
      crc ^= byte;
      for (let bit = 0; bit < 8; bit += 1) {
        crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
      }
    }
    return (crc ^ 0xffffffff) >>> 0;
  };
  const chunk = (name: string, contents: Buffer) => {
    const type = Buffer.from(name, "ascii");
    const length = Buffer.alloc(4);
    length.writeUInt32BE(contents.length);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(Buffer.concat([type, contents])));
    return Buffer.concat([length, type, contents, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 6;
  const row = Buffer.alloc(1 + width * 4);
  for (let x = 0; x < width; x += 1) {
    const offset = 1 + x * 4;
    row[offset] = 40;
    row[offset + 1] = 180;
    row[offset + 2] = 90;
    row[offset + 3] = 255;
  }
  if (alphaAtOrigin) row[4] = 0;
  const raw = Buffer.alloc(row.length * height);
  for (let y = 0; y < height; y += 1) row.copy(raw, y * row.length);
  return Buffer.concat([
    Buffer.from("89504e470d0a1a0a", "hex"),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

function jpegFromPng(png: Buffer, orientation?: number): Buffer {
  const root = mkdtempSync(join(realpathSync(tmpdir()), "ps4d3a2b-jpeg-"));
  try {
    const source = join(root, "source.png");
    const output = join(root, "source.jpg");
    writeFileSync(source, png);
    const converted = spawnSync(
      "/usr/bin/sips",
      ["-s", "format", "jpeg", source, "--out", output],
      { env: { LANG: "C", LC_ALL: "C" } },
    );
    if (converted.status !== 0) {
      throw new Error("synthetic jpeg conversion failed");
    }
    const jpeg = readFileSync(output);
    if (orientation === undefined) return jpeg;
    const tiff = Buffer.alloc(26);
    tiff.write("II", 0, "ascii");
    tiff.writeUInt16LE(42, 2);
    tiff.writeUInt32LE(8, 4);
    tiff.writeUInt16LE(1, 8);
    tiff.writeUInt16LE(0x0112, 10);
    tiff.writeUInt16LE(3, 12);
    tiff.writeUInt32LE(1, 14);
    tiff.writeUInt16LE(orientation, 18);
    const payload = Buffer.concat([Buffer.from("Exif\0\0", "binary"), tiff]);
    const app1 = Buffer.alloc(4);
    app1[0] = 0xff;
    app1[1] = 0xe1;
    app1.writeUInt16BE(payload.length + 2, 2);
    return Buffer.concat([
      jpeg.subarray(0, 2),
      app1,
      payload,
      jpeg.subarray(2),
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const TINY_WEBP = Buffer.from(
  "UklGRiIAAABXRUJQVlA4IBYAAAAwAQCdASoBAAEAAUAmJaQAA3AA/vuUAAA=",
  "base64",
).subarray(0, 42);
const TINY_GIF = Buffer.from(
  "R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==",
  "base64",
);

function animatedGif(): Buffer {
  const descriptor = TINY_GIF.indexOf(0x2c, 19);
  const frame = TINY_GIF.subarray(descriptor, TINY_GIF.length - 1);
  return Buffer.concat([
    TINY_GIF.subarray(0, descriptor),
    frame,
    frame,
    Buffer.from([0x3b]),
  ]);
}

function animatedWebP(): Buffer {
  const chunk = (name: string, payload: Buffer) => {
    const header = Buffer.alloc(8);
    header.write(name, 0, "ascii");
    header.writeUInt32LE(payload.length, 4);
    return Buffer.concat([header, payload, Buffer.alloc(payload.length & 1)]);
  };
  const vp8x = Buffer.alloc(10);
  vp8x[0] = 0x02;
  const frameHeader = Buffer.alloc(16);
  frameHeader.writeUIntLE(100, 12, 3);
  const frame = chunk(
    "ANMF",
    Buffer.concat([frameHeader, TINY_WEBP.subarray(12)]),
  );
  const body = Buffer.concat([
    Buffer.from("WEBP"),
    chunk("VP8X", vp8x),
    chunk("ANIM", Buffer.alloc(6)),
    frame,
    frame,
  ]);
  const riff = Buffer.alloc(8);
  riff.write("RIFF", 0, "ascii");
  riff.writeUInt32LE(body.length, 4);
  return Buffer.concat([riff, body]);
}

function alphaWebP(): Buffer {
  const directory = mkdtempSync(join(realpathSync(tmpdir()), "ps4d3a2b-webp-"));
  try {
    const tool = resolve(
      import.meta.dirname,
      "../../packages/storage/build/image_verifier_fixtures",
    );
    const generated = spawnSync(tool, [directory], { encoding: "utf8" });
    if (generated.status !== 0) {
      throw new Error("synthetic webp fixture failed");
    }
    return readFileSync(join(directory, "alpha.webp"));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

describe.sequential("Phase 4D3a-2b renderer qualification", () => {
  const database = createDatabase(databaseUrl);
  const repository = new MySqlDerivedAdmissionRepository(database.pool);
  const media = new MySqlMediaRepository(database.pool);
  const suffix = randomUUID().replaceAll("-", "");
  const mediaRoot = mkdtempSync(join(realpathSync(tmpdir()), "ps4d3a2b-"));
  chmodSync(mediaRoot, 0o700);
  mkdirSync(join(mediaRoot, "derived"), { mode: 0o700 });
  let storageRoot: StorageRoot;
  let reader: OriginalReader;
  let gate: CapacityGate;
  let store: DerivedStore;
  let capability: StorageCapability & { state: "READ_WRITE" };
  let familyId = "";
  let userId = "";
  let sessionId = "";
  let memberId = "";
  const sessionHash = randomBytes(32);

  beforeAll(async () => {
    const connection = await database.pool.getConnection();
    try {
      const [identity] = await connection.query<RowDataPacket[]>(
        `SELECT DATABASE() AS db, VERSION() AS version,
          CURRENT_USER() AS account,
          @@GLOBAL.innodb_native_foreign_keys AS nativeFk,
          @@SESSION.foreign_key_checks AS foreignKeyChecks`,
      );
      const row = identity[0];
      if (
        row?.db !== "family_album_dev" ||
        !String(row.version).startsWith("9.7.2") ||
        String(row.account).split("@")[0]?.toLowerCase() === "root" ||
        String(row.nativeFk) !== "1" ||
        String(row.foreignKeyChecks) !== "1"
      ) {
        throw new Error("PHASE4D3A2B_DEV_PREFLIGHT_FAILED");
      }
      await assertMigrationReadiness(connection);
      await connection.beginTransaction();
      const [family] = await connection.query<ResultSetHeader>(
        "INSERT INTO families (name) VALUES (?)",
        [`D3a2b synthetic ${suffix}`],
      );
      familyId = String(family.insertId);
      const username = `d3a2b_${suffix}`;
      const [user] = await connection.query<ResultSetHeader>(
        `INSERT INTO users
          (username,username_normalized,password_hash,display_name,password_changed_at)
         VALUES (?,?,?,?,CURRENT_TIMESTAMP(3))`,
        [username, Buffer.from(username), "synthetic-not-used", "D3a2b"],
      );
      userId = String(user.insertId);
      const [session] = await connection.query<ResultSetHeader>(
        `INSERT INTO sessions
          (user_id,token_hash,client_type,authenticated_at,last_seen_at,expires_at)
         VALUES (?,?,'WEB',CURRENT_TIMESTAMP(3),CURRENT_TIMESTAMP(3),
           DATE_ADD(CURRENT_TIMESTAMP(3),INTERVAL 30 DAY))`,
        [userId, sessionHash],
      );
      sessionId = String(session.insertId);
      const [member] = await connection.query<ResultSetHeader>(
        "INSERT INTO family_members (family_id,user_id,role) VALUES (?,?,'MEMBER')",
        [familyId, userId],
      );
      memberId = String(member.insertId);
      await connection.commit();
      storageRoot = StorageRoot.open(mediaRoot, { initialize: true });
      storageRoot.provisionSharedCapacityLockForDev();
      storageRoot.provisionDerivedWriterLockForDev();
      capability = { state: "READ_WRITE", root: storageRoot };
      gate = CapacityGate.open({
        mediaRoot,
        expectedMarkerId: storageRoot.markerId,
      });
      store = DerivedStore.open(capability);
      reader = OriginalReader.open({
        mediaRoot,
        expectedMarkerId: storageRoot.markerId,
      });
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
  });

  afterAll(async () => {
    store?.close();
    reader?.close();
    gate?.close();
    storageRoot?.close();
    rmSync(mediaRoot, { recursive: true, force: true });
    const connection = await database.pool.getConnection();
    try {
      await connection.beginTransaction();
      await connection.query("DELETE FROM derived_assets WHERE family_id=?", [
        familyId,
      ]);
      await connection.query("DELETE FROM background_jobs WHERE family_id=?", [
        familyId,
      ]);
      await connection.query("DELETE FROM media_items WHERE family_id=?", [
        familyId,
      ]);
      await connection.query("DELETE FROM upload_sessions WHERE family_id=?", [
        familyId,
      ]);
      await connection.query("DELETE FROM storage_objects WHERE family_id=?", [
        familyId,
      ]);
      await connection.query("DELETE FROM family_members WHERE user_id=?", [
        userId,
      ]);
      await connection.query("DELETE FROM sessions WHERE id=?", [sessionId]);
      await connection.query("DELETE FROM users WHERE id=?", [userId]);
      await connection.query("DELETE FROM families WHERE id=?", [familyId]);
      await connection.commit();
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
      await database.pool.end();
    }
  });

  async function reservation(
    kind: "THUMBNAIL" | "PREVIEW",
  ): Promise<DerivedReservationIdentity> {
    const sha = createHash("sha256").update(randomBytes(16)).digest();
    const [object] = await database.pool.query<ResultSetHeader>(
      `INSERT INTO storage_objects
        (family_id,sha256,byte_size,key_version,state,durable_at,verified_at)
       VALUES (?,?,2048,1,'AVAILABLE',CURRENT_TIMESTAMP(3),CURRENT_TIMESTAMP(3))`,
      [familyId, sha],
    );
    const [upload] = await database.pool.query<ResultSetHeader>(
      `INSERT INTO upload_sessions
        (public_id,family_id,created_by_member_id,original_filename,
         declared_size,committed_offset,state,computed_sha256,
         finalize_started_at,storage_object_id,completed_at,expires_at)
       VALUES (?,?,?,'synthetic.bin',2048,2048,'COMPLETE',?,
         CURRENT_TIMESTAMP(3),?,CURRENT_TIMESTAMP(3),
         DATE_ADD(CURRENT_TIMESTAMP(3),INTERVAL 1 DAY))`,
      [randomBytes(16), familyId, memberId, sha, String(object.insertId)],
    );
    const created = await media.createOrGetCanonicalMedia({
      familyId,
      uploadId: String(upload.insertId),
    });
    const workerId = randomBytes(16);
    const [job] = await database.pool.query<ResultSetHeader>(
      `INSERT INTO background_jobs
        (family_id,media_id,generation,recipe_id,job_type,state,attempts,
         max_attempts,available_at,locked_at,heartbeat_at,locked_until,
         worker_id,lease_epoch)
       VALUES (?,?,1,1,'IMAGE_DERIVATIVES','RUNNING',1,3,
         CURRENT_TIMESTAMP(3),CURRENT_TIMESTAMP(3),CURRENT_TIMESTAMP(3),
         DATE_ADD(CURRENT_TIMESTAMP(3),INTERVAL 180 SECOND),?,1)`,
      [familyId, created.media.id, workerId],
    );
    return {
      familyId,
      mediaId: created.media.id,
      generation: 1n,
      recipeId: 1,
      kind,
      jobId: String(job.insertId),
      leaseEpoch: 1n,
      workerId,
    };
  }

  async function renderOriginal(bytes: Buffer, kind: "THUMBNAIL" | "PREVIEW") {
    const digest = createHash("sha256").update(bytes).digest("hex");
    const relativePath = buildOriginalPath(
      familyId,
      digest,
      String(bytes.length),
    );
    const path = join(mediaRoot, relativePath);
    if (!existsSync(path)) {
      const uploadId = randomBytes(16).toString("hex");
      storageRoot.createUploadPayload(familyId, uploadId, bytes);
      storageRoot.publishOriginal({
        familyId,
        uploadId,
        sha256Hex: digest,
        byteSize: String(bytes.length),
      });
    }
    const before = {
      bytes: readFileSync(path),
      sha256: digest,
      stat: lstatSync(path, { bigint: true }),
    };
    const candidate = await reader.withVerifiedOriginal(
      {
        familyId,
        sha256Hex: digest,
        byteSize: String(bytes.length),
      },
      (handle) => renderUnverifiedCandidate(handle, kind),
    );
    return { path, before, candidate };
  }

  function originalUnchanged(
    path: string,
    before: {
      bytes: Buffer;
      sha256: string;
      stat: ReturnType<typeof lstatSync>;
    },
  ) {
    const after = lstatSync(path, { bigint: true });
    expect(readFileSync(path)).toEqual(before.bytes);
    expect(createHash("sha256").update(readFileSync(path)).digest("hex")).toBe(
      before.sha256,
    );
    expect(after.ino).toBe(before.stat.ino);
    expect(after.mode).toBe(before.stat.mode);
    expect(after.mtimeNs).toBe(before.stat.mtimeNs);
  }

  async function qualify(
    bytes: Buffer,
    kind: "THUMBNAIL" | "PREVIEW",
    rawWidth: number,
    rawHeight: number,
    orientation = 1,
  ) {
    const rendered = await renderOriginal(bytes, kind);
    const identity = await reservation(kind);
    const admission = await admitDerivedReservation(
      capability,
      gate,
      repository,
      identity,
    );
    if (admission.permit === null) {
      throw new Error("PHASE4D3A2B_ADMISSION_PERMIT_MISSING");
    }
    const writer = await createOwnedDerivedTemp(
      capability,
      store,
      repository,
      admission.permit,
      rendered.candidate,
    );
    const sealed = writer.seal(capability, store);
    const sealedSha = sealed.identity().sha256Hex;
    const verified = sealed.verify(store, {
      epoch: identity.leaseEpoch,
      kind,
    });
    sealed.consume(store);
    const expected = expectedFit(rawWidth, rawHeight, orientation, kind);
    expect(verified.width).toBe(expected.width);
    expect(verified.height).toBe(expected.height);
    expect(verified.staticImage).toBe(true);
    expect(verified.sha256Hex).toBe(rendered.candidate.sha256Hex);
    expect(sealedSha).toBe(rendered.candidate.sha256Hex);
    expect(verified.sha256Hex).toBe(
      createHash("sha256").update(rendered.candidate.bytes).digest("hex"),
    );
    const [rows] = await database.pool.query<RowDataPacket[]>(
      "SELECT state FROM derived_assets WHERE producer_job_id=? AND kind=?",
      [identity.jobId, kind],
    );
    expect(rows[0]?.state).toBe("RESERVED");
    originalUnchanged(rendered.path, rendered.before);
    rmSync(join(mediaRoot, "derived", ".tmp"), {
      recursive: true,
      force: true,
    });
    return { verified, candidate: rendered.candidate };
  }

  it("qualifies JPEG, PNG, WebP, and GIF for both recipes", async () => {
    const jpeg = jpegFromPng(syntheticPng(32, 24));
    const cases: Array<[Buffer, "THUMBNAIL" | "PREVIEW", number, number]> = [
      [jpeg, "THUMBNAIL", 32, 24],
      [jpeg, "PREVIEW", 32, 24],
      [syntheticPng(32, 24), "THUMBNAIL", 32, 24],
      [syntheticPng(32, 24), "PREVIEW", 32, 24],
      [TINY_WEBP, "THUMBNAIL", 1, 1],
      [TINY_WEBP, "PREVIEW", 1, 1],
      [TINY_GIF, "THUMBNAIL", 1, 1],
      [TINY_GIF, "PREVIEW", 1, 1],
    ];
    for (const [bytes, kind, width, height] of cases) {
      const result = await qualify(bytes, kind, width, height);
      expect(result.verified.staticImage).toBe(true);
    }
  });

  it("uses decoded geometry for thumbnail, preview, and no-upscale targets", async () => {
    const small = syntheticPng(320, 240);
    const large = syntheticPng(4000, 3000);
    const square = syntheticPng(100, 100);
    const portrait = syntheticPng(240, 320);
    await qualify(small, "THUMBNAIL", 320, 240);
    await qualify(large, "THUMBNAIL", 4000, 3000);
    await qualify(large, "PREVIEW", 4000, 3000);
    await qualify(square, "THUMBNAIL", 100, 100);
    await qualify(square, "PREVIEW", 100, 100);
    const portraitResult = await qualify(portrait, "THUMBNAIL", 240, 320);
    expect(portraitResult.verified.height).toBeGreaterThan(
      portraitResult.verified.width,
    );
  });

  it("qualifies JPEG orientations from decoded geometry", async () => {
    const png = syntheticPng(320, 240);
    for (const orientation of [1, 5, 6, 7, 8]) {
      const result = await qualify(
        jpegFromPng(png, orientation),
        "THUMBNAIL",
        320,
        240,
        orientation,
      );
      if (orientation >= 5) {
        expect(result.verified.width).toBe(240);
        expect(result.verified.height).toBe(320);
      } else {
        expect(result.verified.width).toBe(320);
        expect(result.verified.height).toBe(240);
      }
    }
  });

  it("keeps PNG and WebP alpha through seal and isolated decode", async () => {
    const png = await qualify(syntheticPng(16, 16, true), "THUMBNAIL", 16, 16);
    expect(png.verified.alpha).toBe(true);
    expect(png.verified.transparent).toBe(true);
    expect(png.candidate.bytes.includes(Buffer.from("ALPH"))).toBe(true);
    const webp = await qualify(alphaWebP(), "PREVIEW", 8, 4);
    expect(webp.verified.alpha).toBe(true);
    expect(webp.verified.transparent).toBe(true);
  });

  it("emits static WebP without EXIF, XMP, or animation chunks", async () => {
    const oriented = await qualify(
      jpegFromPng(syntheticPng(24, 16), 6),
      "THUMBNAIL",
      24,
      16,
      6,
    );
    expect(oriented.candidate.bytes.includes(Buffer.from("EXIF"))).toBe(false);
    expect(oriented.candidate.bytes.includes(Buffer.from("XMP "))).toBe(false);
    expect(oriented.candidate.bytes.includes(Buffer.from("ANIM"))).toBe(false);
    expect(oriented.candidate.bytes.includes(Buffer.from("ANMF"))).toBe(false);
    const gif = await qualify(animatedGif(), "THUMBNAIL", 1, 1);
    expect(gif.verified.staticImage).toBe(true);
    expect(gif.candidate.bytes.includes(Buffer.from("ANIM"))).toBe(false);
    const webp = await qualify(animatedWebP(), "PREVIEW", 1, 1);
    expect(webp.verified.staticImage).toBe(true);
    expect(webp.candidate.bytes.includes(Buffer.from("ANMF"))).toBe(false);
  });

  it("rejects a malformed original before admission and bounds a near-limit image", async () => {
    const [before] = await database.pool.query<RowDataPacket[]>(
      "SELECT COUNT(*) AS count FROM derived_assets WHERE family_id=?",
      [familyId],
    );
    await expect(
      renderOriginal(TINY_GIF.subarray(0, 8), "THUMBNAIL"),
    ).rejects.toThrow(/RENDERER_/u);
    const [after] = await database.pool.query<RowDataPacket[]>(
      "SELECT COUNT(*) AS count FROM derived_assets WHERE family_id=?",
      [familyId],
    );
    expect(Number(after[0]?.count)).toBe(Number(before[0]?.count));
    await qualify(syntheticPng(16384, 1), "THUMBNAIL", 16384, 1);
  });
});
