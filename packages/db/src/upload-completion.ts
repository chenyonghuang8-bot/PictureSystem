import type { Pool, PoolConnection, RowDataPacket } from "mysql2/promise";
import type { UploadPublicResult } from "@family-album/contracts";
import {
  canViewAlbum,
  canUploadToAlbum,
  canEditAlbum,
} from "@family-album/permissions";
import {
  acquireCheckedConnection,
  readServerTime,
  runCheckedTransaction,
} from "./connection.js";
import {
  lockFamily,
  lockActor,
  assertActor,
  lockAlbum,
  lockGrant,
  lockIds,
  albumPermissionContext,
} from "./album-repository.js";
import type { Phase1CActor } from "./phase1c-repository.js";
import {
  UploadRepositoryError,
  type UploadState,
} from "./upload-repository.js";

export type UploadPlacementKey = {
  familyId: string;
  storageObjectId: string;
  sha256: Buffer;
  byteSize: string;
};
type Receipt = RowDataPacket & {
  id: string;
  familyId: string;
  memberId: string;
  publicId: Buffer;
  state: UploadState;
  declaredSize: string;
  committedOffset: string;
  storageObjectId: string | null;
  sha256: Buffer | null;
};
type Target = RowDataPacket & {
  id: string;
  albumId: string;
  state: "PENDING" | "APPLIED";
};
const receiptSql = `SELECT CAST(id AS CHAR) id,CAST(family_id AS CHAR) familyId,CAST(created_by_member_id AS CHAR) memberId,public_id publicId,state,CAST(declared_size AS CHAR) declaredSize,CAST(committed_offset AS CHAR) committedOffset,CAST(storage_object_id AS CHAR) storageObjectId,computed_sha256 sha256 FROM upload_sessions WHERE public_id=?`;

export async function discoverUploadPlacementKey(
  pool: Pool,
  actor: Phase1CActor,
  publicId: Buffer,
): Promise<UploadPlacementKey> {
  const c = await acquireCheckedConnection(pool);
  try {
    const [rows] = await c.query<RowDataPacket[]>(
      `SELECT CAST(u.family_id AS CHAR) familyId,CAST(s.id AS CHAR) storageObjectId,s.sha256,CAST(s.byte_size AS CHAR) byteSize FROM upload_sessions u JOIN storage_objects s ON s.family_id=u.family_id AND s.id=u.storage_object_id JOIN family_members owner ON owner.family_id=u.family_id AND owner.id=u.created_by_member_id WHERE u.public_id=? AND owner.user_id=? AND u.state='COMPLETE' AND s.state='AVAILABLE'`,
      [publicId, actor.userId],
    );
    const row = rows[0];
    if (!row || !Buffer.isBuffer(row.sha256) || row.sha256.length !== 32)
      throw new UploadRepositoryError("NOT_FOUND");
    return {
      familyId: row.familyId,
      storageObjectId: row.storageObjectId,
      sha256: row.sha256,
      byteSize: row.byteSize,
    };
  } finally {
    c.release();
  }
}

async function begin(c: PoolConnection, actor: Phase1CActor, publicId: Buffer) {
  const [located] = await c.query<Receipt[]>(receiptSql, [publicId]);
  if (!located[0]) throw new UploadRepositoryError("NOT_FOUND");
  const familyId = located[0].familyId;
  await lockFamily(c, familyId);
  const auth = await lockActor(c, familyId, actor);
  assertActor(auth, actor, await readServerTime(c));
  return { familyId, auth };
}
async function lockReceipt(
  c: PoolConnection,
  publicId: Buffer,
  familyId: string,
  memberId: string,
) {
  const [rows] = await c.query<Receipt[]>(`${receiptSql} FOR UPDATE`, [
    publicId,
  ]);
  const receipt = rows[0];
  if (
    !receipt ||
    receipt.familyId !== familyId ||
    receipt.memberId !== memberId
  )
    throw new UploadRepositoryError("NOT_FOUND");
  return receipt;
}
async function targets(
  c: PoolConnection,
  familyId: string,
  receiptId: string,
  lock = true,
) {
  const [rows] = await c.query<Target[]>(
    `SELECT CAST(id AS CHAR) id,CAST(album_id AS CHAR) albumId,state FROM upload_album_targets WHERE family_id=? AND upload_session_id=? ORDER BY album_id,id ${lock ? "FOR UPDATE" : ""}`,
    [familyId, receiptId],
  );
  if (rows.length > 20) throw new UploadRepositoryError("CONFLICT");
  return rows;
}
async function albumScopes(
  c: PoolConnection,
  familyId: string,
  auth: Awaited<ReturnType<typeof lockActor>>,
  ids: readonly string[],
) {
  const albums = [];
  for (const id of ids) albums.push(await lockAlbum(c, familyId, id));
  // Grants are locked by primary key before reading each album's grant.
  if (ids.length) {
    const [grants] = await c.query<RowDataPacket[]>(
      `SELECT CAST(id AS CHAR) id FROM album_members WHERE family_id=? AND member_id=? AND album_id IN (${ids.map(() => "?").join(",")}) ORDER BY id`,
      [familyId, auth.member.id, ...ids],
    );
    await lockIds(
      c,
      "album_members",
      grants.map((r) => r.id),
    );
  }
  const result = [];
  for (const album of albums) {
    const grant = album
      ? await lockGrant(c, familyId, album.id, auth.member.id)
      : undefined;
    const context = album
      ? albumPermissionContext(album, auth.member, grant)
      : undefined;
    result.push({
      album,
      visible: context ? canViewAlbum(context) : false,
      writable: context
        ? canUploadToAlbum(context) || canEditAlbum(context)
        : false,
    });
  }
  return result;
}
async function content(c: PoolConnection, receipt: Receipt) {
  if (receipt.state !== "COMPLETE" || !receipt.storageObjectId)
    return {
      ready: false,
      failed: receipt.state === "FAILED",
      mediaId: undefined,
    };
  const [objects] = await c.query<RowDataPacket[]>(
    "SELECT sha256,CAST(byte_size AS CHAR) byteSize,state,key_version keyVersion FROM storage_objects WHERE family_id=? AND id=? FOR SHARE",
    [receipt.familyId, receipt.storageObjectId],
  );
  const object = objects[0];
  if (
    !object ||
    object.state !== "AVAILABLE" ||
    object.keyVersion !== 1 ||
    object.byteSize !== receipt.declaredSize ||
    receipt.committedOffset !== receipt.declaredSize ||
    !Buffer.isBuffer(receipt.sha256) ||
    !Buffer.isBuffer(object.sha256) ||
    !receipt.sha256.equals(object.sha256)
  )
    return { ready: false, failed: false, mediaId: undefined };
  const [mediaRows] = await c.query<RowDataPacket[]>(
    `SELECT CAST(id AS CHAR) id,CAST(source_upload_id AS CHAR) sourceUploadId,CAST(generation AS CHAR) generation,CAST(metadata_generation AS CHAR) metadataGeneration,recipe_id recipeId,processing_state processingState,media_type mediaType,trashed_at trashedAt,purge_intent_id purgeIntentId FROM media_items WHERE family_id=? AND storage_object_id=? FOR UPDATE`,
    [receipt.familyId, receipt.storageObjectId],
  );
  const media = mediaRows[0];
  if (!media || media.trashedAt !== null || media.purgeIntentId !== null)
    return { ready: false, failed: false, mediaId: undefined };
  // The existing reconciler owns canonical creation/source choice. A later receipt cannot change it.
  const [source] = await c.query<RowDataPacket[]>(
    `SELECT 1 FROM upload_sessions WHERE family_id=? AND id=? AND storage_object_id=? AND state='COMPLETE' AND committed_offset=declared_size AND declared_size=? AND computed_sha256=?`,
    [
      receipt.familyId,
      media.sourceUploadId,
      receipt.storageObjectId,
      object.byteSize,
      object.sha256,
    ],
  );
  const [assets] = await c.query<RowDataPacket[]>(
    `SELECT kind,state,CAST(byte_size AS CHAR) byteSize,CAST(reserved_bytes AS CHAR) reservedBytes,sha256,width,height,output_mime outputMime,producer_job_id producerJobId,producer_lease_epoch producerLeaseEpoch,published_at publishedAt,cleaned_at cleanedAt FROM derived_assets WHERE family_id=? AND media_id=? AND generation=? AND recipe_id=? AND kind IN ('PREVIEW','THUMBNAIL') ORDER BY kind,id FOR UPDATE`,
    [receipt.familyId, media.id, media.generation, media.recipeId],
  );
  const valid = (kind: string, maxBytes: bigint, maxDimension: number) =>
    assets.some(
      (a) =>
        a.kind === kind &&
        a.state === "READY" &&
        a.cleanedAt === null &&
        a.publishedAt !== null &&
        a.outputMime === "image/webp" &&
        a.byteSize !== null &&
        BigInt(a.byteSize) > 0n &&
        BigInt(a.byteSize) <= BigInt(a.reservedBytes) &&
        BigInt(a.reservedBytes) <= maxBytes &&
        Buffer.isBuffer(a.sha256) &&
        a.sha256.length === 32 &&
        a.width >= 1 &&
        a.width <= maxDimension &&
        a.height >= 1 &&
        a.height <= maxDimension &&
        BigInt(a.producerJobId) > 0n &&
        a.producerLeaseEpoch !== null &&
        BigInt(a.producerLeaseEpoch) > 0n,
    );
  return {
    ready:
      !!source[0] &&
      media.mediaType === "IMAGE" &&
      media.processingState === "READY" &&
      media.metadataGeneration === media.generation &&
      media.recipeId === 1 &&
      valid("PREVIEW", 4194304n, 2560) &&
      valid("THUMBNAIL", 524288n, 480),
    failed: !!source[0] && media.processingState === "FAILED",
    mediaId: media.id as string,
  };
}

export async function observeUploadResult(
  pool: Pool,
  actor: Phase1CActor,
  publicId: Buffer,
): Promise<UploadPublicResult> {
  return runCheckedTransaction(pool, async (c) => {
    const { familyId, auth } = await begin(c, actor, publicId);
    const receipt = await lockReceipt(c, publicId, familyId, auth.member.id);
    const state = await content(c, receipt);
    const selected = await targets(c, familyId, receipt.id);
    const scopes = await albumScopes(
      c,
      familyId,
      auth,
      selected.map((t) => t.albumId),
    );
    let visibleAlbumId: string | undefined;
    const live = new Set<string>();
    if (state.ready && state.mediaId)
      for (let i = 0; i < selected.length; i++) {
        const [placement] = await c.query<RowDataPacket[]>(
          "SELECT id FROM album_media WHERE family_id=? AND album_id=? AND media_id=? FOR UPDATE",
          [familyId, selected[i]!.albumId, state.mediaId],
        );
        if (placement[0]) live.add(selected[i]!.albumId);
        if (
          selected[i]!.state === "APPLIED" &&
          scopes[i]!.visible &&
          placement[0] &&
          !visibleAlbumId
        )
          visibleAlbumId = selected[i]!.albumId;
      }
    assertActor(auth, actor, await readServerTime(c));
    const terminal = ["ABORTED", "EXPIRED", "RETIRED"].includes(receipt.state);
    const processing = state.ready
      ? "READY"
      : state.failed
        ? "FAILED"
        : terminal
          ? "UNAVAILABLE"
          : receipt.state === "COMPLETE" && !state.mediaId
            ? "UNAVAILABLE"
            : "PENDING";
    const needs =
      selected.length === 0 ||
      selected.some(
        (t, i) =>
          !scopes[i]!.visible ||
          (t.state === "PENDING" && !scopes[i]!.writable) ||
          (t.state === "APPLIED" && !live.has(t.albumId)),
      );
    if (needs) visibleAlbumId = undefined;
    return {
      uploadId: receipt.publicId.toString("hex"),
      state: receipt.state,
      declaredSize: receipt.declaredSize,
      committedOffset: receipt.committedOffset,
      processing,
      placement: visibleAlbumId
        ? "APPLIED"
        : needs
          ? "NEEDS_ALBUM_ACTION"
          : "PENDING",
      retryable: !terminal && processing !== "FAILED",
      ...(visibleAlbumId
        ? { mediaId: state.mediaId!, albumId: visibleAlbumId }
        : {}),
    };
  });
}

export async function replaceUploadTargets(
  pool: Pool,
  actor: Phase1CActor,
  publicId: Buffer,
  albumIds: readonly string[],
) {
  return runCheckedTransaction(pool, async (c) => {
    const { familyId, auth } = await begin(c, actor, publicId);
    const scopes = await albumScopes(c, familyId, auth, albumIds);
    const receipt = await lockReceipt(c, publicId, familyId, auth.member.id);
    const current = await targets(c, familyId, receipt.id);
    if (
      current.some((t) => t.state === "APPLIED") ||
      ["ABORTED", "EXPIRED", "RETIRED", "FAILED"].includes(receipt.state)
    )
      throw new UploadRepositoryError("UPLOAD_STATE_CONFLICT");
    if (scopes.some((s) => !s.visible || !s.writable))
      throw new UploadRepositoryError("NOT_FOUND");
    const now = await readServerTime(c);
    assertActor(auth, actor, now);
    await c.query(
      "DELETE FROM upload_album_targets WHERE family_id=? AND upload_session_id=?",
      [familyId, receipt.id],
    );
    for (const albumId of albumIds)
      await c.query(
        "INSERT INTO upload_album_targets(family_id,upload_session_id,album_id,created_at,updated_at) VALUES(?,?,?,?,?)",
        [familyId, receipt.id, albumId, now, now],
      );
  });
}

// Caller holds the OS K lifecycle shared guard before entering this SQL transaction.
export async function applyUploadPlacement(
  pool: Pool,
  actor: Phase1CActor,
  publicId: Buffer,
  key: UploadPlacementKey,
) {
  return runCheckedTransaction(pool, async (c) => {
    const { familyId, auth } = await begin(c, actor, publicId);
    if (familyId !== key.familyId) throw new UploadRepositoryError("CONFLICT");
    const [located] = await c.query<Receipt[]>(receiptSql, [publicId]);
    const selected = await targets(c, familyId, located[0]!.id, false);
    const scopes = await albumScopes(
      c,
      familyId,
      auth,
      selected.map((t) => t.albumId),
    );
    const receipt = await lockReceipt(c, publicId, familyId, auth.member.id);
    if (
      receipt.state !== "COMPLETE" ||
      receipt.storageObjectId !== key.storageObjectId ||
      receipt.declaredSize !== key.byteSize ||
      !receipt.sha256?.equals(key.sha256)
    )
      throw new UploadRepositoryError("UPLOAD_STATE_CONFLICT");
    const state = await content(c, receipt);
    const current = await targets(c, familyId, receipt.id);
    if (
      !state.ready ||
      !state.mediaId ||
      !current.length ||
      current.some((t, i) => t.id !== selected[i]?.id)
    )
      throw new UploadRepositoryError("UPLOAD_STATE_CONFLICT");
    if (scopes.some((s) => !s.visible || !s.writable))
      throw new UploadRepositoryError("NOT_FOUND");
    const now = await readServerTime(c);
    assertActor(auth, actor, now);
    for (const target of current) {
      if (target.state === "APPLIED") continue; // Historical completion never restores a manually removed placement.
      const [existing] = await c.query<RowDataPacket[]>(
        "SELECT id FROM album_media WHERE family_id=? AND album_id=? AND media_id=? FOR UPDATE",
        [familyId, target.albumId, state.mediaId],
      );
      if (!existing[0])
        await c.query(
          "INSERT INTO album_media(family_id,album_id,media_id) VALUES(?,?,?)",
          [familyId, target.albumId, state.mediaId],
        );
      await c.query(
        "UPDATE upload_album_targets SET state='APPLIED',applied_at=?,updated_at=? WHERE id=? AND state='PENDING'",
        [now, now, target.id],
      );
    }
  });
}
