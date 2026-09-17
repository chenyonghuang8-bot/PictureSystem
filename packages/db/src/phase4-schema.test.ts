import { getTableConfig, MySqlDialect } from "drizzle-orm/mysql-core";
import { describe, expect, it } from "vitest";

import { databaseConnectionDefaults } from "./index.js";
import {
  backgroundJobs,
  derivedAssets,
  mediaItems,
  phase4FailureCodes,
  phase4WarningFlags,
  uploadSessions,
} from "./schema.js";

const dialect = new MySqlDialect();

describe("Phase 4A Drizzle schema", () => {
  it("gives one logical media to each family-scoped canonical original", () => {
    expect([mediaItems, backgroundJobs, derivedAssets].map((table) =>
      getTableConfig(table).name,
    )).toEqual(["media_items", "background_jobs", "derived_assets"]);
    expect(
      getTableConfig(mediaItems).indexes.find(
        (item) => item.config.name === "uq_media_items_family_storage_object",
      )?.config.columns.map((column) => column.name),
    ).toEqual(["family_id", "storage_object_id"]);
    expect(
      getTableConfig(uploadSessions).indexes.find(
        (item) => item.config.name === "uq_upload_sessions_family_id_object",
      )?.config.columns.map((column) => column.name),
    ).toEqual(["family_id", "id", "storage_object_id"]);
    expect(
      getTableConfig(mediaItems).foreignKeys.map((key) => key.getName()),
    ).toEqual(["fk_media_items_storage_object", "fk_media_items_source_upload"]);
    const source = getTableConfig(mediaItems).foreignKeys[1]!.reference();
    expect(source.columns.map((column) => column.name)).toEqual([
      "family_id", "source_upload_id", "storage_object_id",
    ]);
    expect(source.foreignColumns.map((column) => column.name)).toEqual([
      "family_id", "id", "storage_object_id",
    ]);
  });

  it("keeps exact IDs, duration, versions and worker IDs precision safe", () => {
    for (const column of [
      mediaItems.id,
      mediaItems.familyId,
      mediaItems.storageObjectId,
      mediaItems.sourceUploadId,
      mediaItems.generation,
      mediaItems.metadataGeneration,
      mediaItems.durationMs,
      backgroundJobs.id,
      backgroundJobs.mediaId,
      backgroundJobs.generation,
      backgroundJobs.leaseEpoch,
      derivedAssets.id,
      derivedAssets.mediaId,
      derivedAssets.generation,
      derivedAssets.reservedBytes,
      derivedAssets.byteSize,
    ]) {
      expect(column.getSQLType()).toBe("bigint unsigned");
      expect(column.dataType).toBe("bigint");
    }
    expect(mediaItems.id.mapFromDriverValue("9007199254740993")).toBe(
      9007199254740993n,
    );
    expect(databaseConnectionDefaults.bigNumberStrings).toBe(true);
    expect(backgroundJobs.workerId.getSQLType()).toBe("binary(16)");
    expect(() =>
      backgroundJobs.workerId.mapToDriverValue(Buffer.alloc(15)),
    ).toThrow();
    expect(derivedAssets.sha256.getSQLType()).toBe("binary(32)");
    expect(() =>
      derivedAssets.sha256.mapToDriverValue(Buffer.alloc(31)),
    ).toThrow();
  });

  it("stores bounded metadata, local capture time and paired decimal GPS", () => {
    expect(mediaItems.detectedMime.getSQLType()).toBe("varchar(127)");
    expect(mediaItems.rawWidth.getSQLType()).toBe("int unsigned");
    expect(mediaItems.displayHeight.getSQLType()).toBe("int unsigned");
    expect(mediaItems.orientation.getSQLType()).toBe("tinyint unsigned");
    expect(mediaItems.gpsLatitude.getSQLType()).toBe("decimal(9,6)");
    expect(mediaItems.gpsLongitude.getSQLType()).toBe("decimal(10,6)");
    for (const field of [
      mediaItems.capturedLocalAt,
      mediaItems.capturedAtUtc,
      mediaItems.timelineKey,
      mediaItems.uploadedAt,
    ]) {
      expect(field.getSQLType()).toBe("datetime(3)");
    }
    expect(mediaItems.capturedTimeStatus.enumValues).toEqual([
      "ABSENT",
      "OFFSET_KNOWN",
      "OFFSET_UNKNOWN",
    ]);
    expect(mediaItems.timelineBasis.enumValues).toEqual([
      "CAPTURE_LOCAL",
      "UPLOAD_UTC",
    ]);
    const gps = getTableConfig(mediaItems).checks.find(
      (item) => item.name === "chk_media_items_gps",
    )!;
    const expression = dialect.sqlToQuery(gps.value).sql;
    expect(expression).toContain("`gps_latitude` IS NULL AND");
    expect(expression).toContain("`gps_longitude` IS NOT NULL");
    expect(expression).toContain("BETWEEN -90 AND 90");
    expect(expression).toContain("BETWEEN -180 AND 180");
    expect(
      getTableConfig(mediaItems).checks.map((item) => item.name),
    ).toEqual(expect.arrayContaining([
      "chk_media_items_raw_dimensions",
      "chk_media_items_display_dimensions",
      "chk_media_items_orientation",
      "chk_media_items_capture",
      "chk_media_items_timeline",
      "chk_media_items_ready_metadata",
    ]));
  });

  it("gives derived and jobs same-family references and generation-scoped identity", () => {
    expect(
      getTableConfig(backgroundJobs).indexes.find(
        (item) => item.config.name === "uq_background_jobs_identity",
      )?.config.columns.map((column) => column.name),
    ).toEqual([
      "family_id", "media_id", "generation", "recipe_id", "job_type",
    ]);
    expect(
      getTableConfig(derivedAssets).indexes.find(
        (item) => item.config.name === "uq_derived_assets_identity",
      )?.config.columns.map((column) => column.name),
    ).toEqual([
      "family_id", "media_id", "generation", "recipe_id", "kind",
    ]);
    expect(
      getTableConfig(backgroundJobs).foreignKeys.map((key) => key.getName()),
    ).toEqual(["fk_background_jobs_media"]);
    expect(
      getTableConfig(derivedAssets).foreignKeys.map((key) => key.getName()),
    ).toEqual(["fk_derived_assets_media", "fk_derived_assets_producer_job"]);
    for (const key of [
      ...getTableConfig(backgroundJobs).foreignKeys,
      ...getTableConfig(derivedAssets).foreignKeys,
    ]) {
      expect(key.onDelete).toBe("restrict");
      expect(key.onUpdate).toBe("restrict");
      expect(key.reference().columns[0]?.name).toBe("family_id");
    }
    expect(backgroundJobs.jobType.enumValues).toEqual([
      "MEDIA_PROBE", "IMAGE_DERIVATIVES", "VIDEO_POSTER",
    ]);
    expect(derivedAssets.kind.enumValues).toEqual([
      "THUMBNAIL", "PREVIEW", "VIDEO_POSTER",
    ]);
  });

  it("uses controlled failures and has no client path, raw metadata or original delete field", () => {
    expect(mediaItems.lastFailureCode.enumValues).toEqual([
      ...phase4FailureCodes,
    ]);
    expect(backgroundJobs.lastFailureCode.enumValues).toEqual([
      ...phase4FailureCodes,
    ]);
    expect(derivedAssets.failureCode.enumValues).toEqual([
      ...phase4FailureCodes,
    ]);
    expect(
      Object.values(phase4WarningFlags).reduce((mask, flag) => mask | flag, 0n),
    ).toBe(255n);
    const forbidden = [
      "raw_exif", "raw_xmp", "absolute_path", "client_filename", "source_url",
      "original_delete", "album_id", "ai_embedding", "transcode_path",
    ];
    const columns = [mediaItems, backgroundJobs, derivedAssets].flatMap(
      (table) => getTableConfig(table).columns.map((column) => column.name),
    );
    for (const name of forbidden) expect(columns).not.toContain(name);
  });
});
