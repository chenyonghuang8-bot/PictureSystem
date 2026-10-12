import { canonicalCheck } from "./check-expression.js";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  buildExpectedSchemaSnapshot,
  buildRunProofPredecessorSchemaSnapshot,
  loadExpectedMigrationManifest,
} from "./migration-readiness.js";
const sql = readFileSync(
  new URL("../drizzle/0011_phase_11_run_proofs.sql", import.meta.url),
  "utf8",
);
describe("R1 additive run certificate migration", () => {
  it("adds only two run tables, nullable current pointer and monotone epoch, without certificates or data rewrites", async () => {
    const manifest = await loadExpectedMigrationManifest();
    expect(manifest.at(-1)?.tag).toBe("0011_phase_11_run_proofs");
    expect(sql).not.toMatch(
      /\b(?:DROP\s+TABLE|TRUNCATE\s|DELETE\s+FROM|INSERT\s+INTO|UPDATE\s+`)/iu,
    );
    const before = buildRunProofPredecessorSchemaSnapshot(),
      after = buildExpectedSchemaSnapshot();
    expect(after.tables.length - before.tables.length).toBe(2);
    for (const table of before.tables) {
      const next = after.tables.find((t) => t.name === table.name)!;
      if (table.name === "system_control") {
        expect(
          next.columns.filter(
            (c) => !["current_run_id", "run_epoch"].includes(c.name),
          ),
        ).toEqual(table.columns);
        expect(
          next.foreignKeys.filter((f) => !f.columns.includes("current_run_id")),
        ).toEqual(table.foreignKeys);
        expect(next.indexes).toEqual(table.indexes);
        expect(next.checks).toEqual(table.checks);
      } else if (table.name === "admin_audit_events") {
        expect(next.columns.filter((c) => c.name !== "action")).toEqual(
          table.columns.filter((c) => c.name !== "action"),
        );
        expect(next.foreignKeys).toEqual(table.foreignKeys);
        expect(next.indexes).toEqual(table.indexes);
        expect(next.checks).toEqual(table.checks);
      } else expect(next).toEqual(table);
    }
  });
  it("canonicalizes only the exact owner membership CHECK without weakening its comparison", () => {
    expect(
      canonicalCheck(
        "FIND_IN_SET(`system_control_runs`.`owner_role`,`system_control_runs`.`expected_roles`)>0",
      ),
    ).toBe(canonicalCheck("(find_in_set(`owner_role`,`expected_roles`) > 0)"));
    expect(
      canonicalCheck("find_in_set(owner_role,expected_roles)>=0"),
    ).not.toBe(canonicalCheck("find_in_set(owner_role,expected_roles)>0"));
    expect(canonicalCheck("find_in_set(owner_role,other_roles)>0")).not.toBe(
      canonicalCheck("find_in_set(owner_role,expected_roles)>0"),
    );
  });
  it("does not let nullable SQL CHECK fields masquerade as CLEAN and enforces unique consumption/boot/role", () => {
    expect(sql).toContain("shutdown_operation_id` IS NOT NULL");
    expect(sql).toContain("clean_requested_mode` IS NOT NULL");
    expect(sql).toContain("member_manifest` IS NOT NULL");
    expect(sql).toContain("ack_operation_id` IS NOT NULL");
    expect(sql).toContain("uq_system_control_runs_predecessor");
    expect(sql).toContain("uq_system_control_run_members_boot");
    expect(sql).toContain("uq_system_control_run_members_role");
    expect(sql).toContain("ON DELETE restrict ON UPDATE restrict");
  });
});
