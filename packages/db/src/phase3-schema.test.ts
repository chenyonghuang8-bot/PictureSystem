import { getTableConfig } from "drizzle-orm/mysql-core";
import { describe, expect, it } from "vitest";

import { storageObjects, uploadSessions } from "./schema.js";

describe("Phase 3B Drizzle schema", () => {
  it("defines exactly the two Phase 3 tables with precision-safe binary identities", () => {
    expect(
      [storageObjects, uploadSessions].map(
        (table) => getTableConfig(table).name,
      ),
    ).toEqual(["storage_objects", "upload_sessions"]);
    for (const column of [
      storageObjects.id,
      storageObjects.familyId,
      storageObjects.byteSize,
      uploadSessions.id,
      uploadSessions.familyId,
      uploadSessions.createdByMemberId,
      uploadSessions.declaredSize,
      uploadSessions.committedOffset,
      uploadSessions.storageObjectId,
    ]) {
      expect(column.getSQLType()).toBe("bigint unsigned");
      expect(column.dataType).toBe("bigint");
    }
    expect(storageObjects.sha256.getSQLType()).toBe("binary(32)");
    expect(uploadSessions.computedSha256.getSQLType()).toBe("binary(32)");
    expect(uploadSessions.publicId.getSQLType()).toBe("binary(16)");
    expect(() =>
      storageObjects.sha256.mapToDriverValue(Buffer.alloc(31)),
    ).toThrow();
    expect(() =>
      uploadSessions.publicId.mapToDriverValue(Buffer.alloc(15)),
    ).toThrow();
  });

  it("defines family-scoped storage identity and exact dedupe indexes", () => {
    const config = getTableConfig(storageObjects);
    expect(config.indexes.map((item) => item.config.name)).toEqual([
      "uq_storage_objects_family_id",
      "uq_storage_objects_family_hash_size",
      "idx_storage_objects_state_verified",
    ]);
    expect(config.foreignKeys.map((item) => item.getName())).toEqual([
      "fk_storage_objects_family",
    ]);
    expect(config.checks.map((item) => item.name)).toEqual([
      "chk_storage_objects_size",
      "chk_storage_objects_key_version",
      "chk_storage_objects_verified",
    ]);
    expect(storageObjects.state.enumValues).toEqual([
      "AVAILABLE",
      "MISSING",
      "CORRUPT",
    ]);
  });

  it("defines receipt, cleanup and same-family upload boundaries", () => {
    const config = getTableConfig(uploadSessions);
    expect(config.indexes.map((item) => item.config.name)).toEqual([
      "uq_upload_sessions_public_id",
      "uq_upload_sessions_family_id_object",
      "idx_upload_sessions_family_creator_state",
      "idx_upload_sessions_state_expiry",
      "idx_upload_sessions_family_object",
      "idx_upload_sessions_cleanup",
    ]);
    expect(config.foreignKeys.map((item) => item.getName())).toEqual([
      "fk_upload_sessions_family",
      "fk_upload_sessions_creator_member",
      "fk_upload_sessions_storage_object",
    ]);
    expect(config.checks.map((item) => item.name)).toEqual([
      "chk_upload_sessions_size_offset",
      "chk_upload_sessions_expiry",
      "chk_upload_sessions_created",
      "chk_upload_sessions_uploading",
      "chk_upload_sessions_finalize_pair",
      "chk_upload_sessions_finalize_state",
      "chk_upload_sessions_complete",
      "chk_upload_sessions_terminal",
      "chk_upload_sessions_failure",
      "chk_upload_sessions_times",
    ]);
    expect(uploadSessions.state.enumValues).toEqual([
      "CREATED",
      "UPLOADING",
      "FINALIZING",
      "COMPLETE",
      "FAILED",
      "ABORTED",
      "EXPIRED",
    ]);
  });

  it("stores bounded display hints but no client-controlled filesystem path", () => {
    expect(uploadSessions.originalFilename.getSQLType()).toBe("varchar(255)");
    expect(uploadSessions.reportedMime.getSQLType()).toBe("varchar(127)");
    expect(
      [storageObjects, uploadSessions].flatMap((table) =>
        getTableConfig(table).columns.map((column) => column.name),
      ),
    ).not.toEqual(
      expect.arrayContaining([
        "absolute_path",
        "filename_path",
        "media_root",
        "storage_key",
        "staging_key",
        "client_sha256",
      ]),
    );
  });
});
