import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { describe, it, expect } from "vitest";
import { createUploadFingerprint } from "./upload-repository.js";
import {
  buildExpectedSchemaSnapshot,
  buildPhase10PredecessorSchemaSnapshot,
  loadExpectedMigrationManifest,
} from "./migration-readiness.js";
const root = new URL("../../../", import.meta.url);
describe("Phase10 bounded additive migration and operation identity", () => {
  it("keeps every applied predecessor migration byte-for-byte", async () => {
    const manifest = await loadExpectedMigrationManifest();
    expect(manifest).toHaveLength(10);
    expect(manifest[9]?.tag).toBe("0009_phase_10_android");
    for (const previous of manifest.slice(0, 9)) {
      const path = `packages/db/drizzle/${previous.tag}.sql`;
      expect(
        readFileSync(new URL(path, root)).equals(
          execFileSync(
            "git",
            ["show", `6510261f920b5ebe6d98d1cefa3227fb221bbd5f:${path}`],
            { cwd: root },
          ),
        ),
      ).toBe(true);
    }
  });
  it("adds only upload fields/identity and target table, with same-family restrictive FKs and no media child", () => {
    const before = buildPhase10PredecessorSchemaSnapshot(),
      after = buildExpectedSchemaSnapshot();
    expect(after.tables.length - before.tables.length).toBe(1);
    const target = after.tables.find((t) => t.name === "upload_album_targets")!;
    expect(target.foreignKeys.map((f) => f.referencedTable).sort()).toEqual([
      "albums",
      "upload_sessions",
    ]);
    expect(
      target.foreignKeys.every(
        (f) => f.onDelete === "RESTRICT" && f.onUpdate === "RESTRICT",
      ),
    ).toBe(true);
    const upload = after.tables.find((t) => t.name === "upload_sessions")!;
    expect(
      upload.columns
        .filter((c) => c.name.startsWith("client_operation_"))
        .map((c) => [c.name, c.type, c.nullable]),
    ).toEqual([
      ["client_operation_fingerprint", "binary(32)", true],
      ["client_operation_id", "binary(16)", true],
    ]);
    expect(after.tables.some((t) => t.name.includes("device"))).toBe(false);
  });
  it("fingerprint excludes random receipt/actor and normalizes names/hints; original targets remain immutable", () => {
    const input = {
      actor: { userId: "1", sessionId: "2", tokenHash: Buffer.alloc(32) },
      familyId: "1",
      publicId: Buffer.alloc(16),
      declaredSize: 100n,
      originalFilename: "e\u0301.jpg",
      reportedMime: " IMAGE/JPEG ",
      clientOperationId: Buffer.alloc(16, 1),
      targetAlbumIds: ["3", "4"],
    };
    const a = createUploadFingerprint(input);
    expect(
      a.equals(
        createUploadFingerprint({
          ...input,
          publicId: Buffer.alloc(16, 3),
          originalFilename: "é.jpg",
          reportedMime: "image/jpeg",
        }),
      ),
    ).toBe(true);
    expect(
      a.equals(createUploadFingerprint({ ...input, targetAlbumIds: ["3"] })),
    ).toBe(false);
  });
});
