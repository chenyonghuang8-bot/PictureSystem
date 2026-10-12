import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { describe, it, expect } from "vitest";
import {
  buildRunProofPredecessorSchemaSnapshot,
  buildPhase11PredecessorSchemaSnapshot,
  loadExpectedMigrationManifest,
} from "./migration-readiness.js";
const root = new URL("../../../", import.meta.url);
describe("Phase11 bounded additive control migration", () => {
  it("preserves 0000 through 0009 and creates the protected singleton without default grants", async () => {
    const manifest = await loadExpectedMigrationManifest();
    expect(manifest).toHaveLength(12);
    expect(manifest[10]?.tag).toBe("0010_phase_11_admin");
    for (const migration of manifest.slice(0, 10)) {
      const path = `packages/db/drizzle/${migration.tag}.sql`;
      expect(
        readFileSync(new URL(path, root)).equals(
          execFileSync(
            "git",
            ["show", `209b8d36e4a9337ee6c9975878f6031e52a62ace:${path}`],
            { cwd: root },
          ),
        ),
      ).toBe(true);
    }
    const sql = readFileSync(
      new URL("packages/db/drizzle/0010_phase_11_admin.sql", root),
      "utf8",
    );
    expect(sql).not.toMatch(/DROP |TRUNCATE |DELETE FROM /u);
    expect(sql).toContain(
      "'READ_ONLY','READ_ONLY','RECOVERY_REQUIRED',1,1,true,'NOT_INITIALIZED'",
    );
    expect(sql).not.toMatch(/INSERT INTO `system_admin_grants`/u);
  });
  it("adds five dedicated tables and a restrictive identity grant FK without changing old audit/media schema", () => {
    const before = buildPhase11PredecessorSchemaSnapshot(),
      after = buildRunProofPredecessorSchemaSnapshot();
    expect(after.tables.length - before.tables.length).toBe(5);
    for (const t of before.tables) {
      const current = after.tables.find((x) => x.name === t.name)!;
      if (t.name === "family_members") {
        expect(current.columns).toEqual(t.columns);
        expect(current.foreignKeys).toEqual(t.foreignKeys);
        expect(
          current.indexes.filter((x) => x.name !== "uq_family_members_binding"),
        ).toEqual(t.indexes);
      } else expect(current).toEqual(t);
    }
    const grant = after.tables.find((x) => x.name === "system_admin_grants")!;
    expect(grant.foreignKeys).toHaveLength(1);
    expect(grant.foreignKeys[0]).toMatchObject({
      columns: ["family_id", "member_id", "user_id"],
      referencedColumns: ["family_id", "id", "user_id"],
      onDelete: "RESTRICT",
      onUpdate: "RESTRICT",
    });
  });
});
