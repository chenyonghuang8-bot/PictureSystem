import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PoolConnection } from "mysql2/promise";
import {
  retiredDigest,
  verifyRetiredControlFixtures,
} from "../../../tests/helpers/retired-control-fixtures.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "retired-control-unit-"));
  dirs.push(dir);
  const file = join(dir, "registry.json");
  const tables = [
    "families",
    "users",
    "family_members",
    "system_control_operations",
    "system_control_runs",
    "system_control_run_members",
    "admin_runtime_observations",
    "admin_audit_events",
    "audit_logs",
    "purge_intents",
    "purge_files",
  ];
  const rows: Record<string, unknown[]> = Object.fromEntries(
    tables.map((table) => [table, []]),
  );
  rows.families = [{ id: "1", name: "exact synthetic actor" }];
  rows.system_control_operations = [
    {
      id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
      status: "RECOVERY_REQUIRED",
      result_revision: null,
    },
  ];
  const record = {
    retirementId: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
    status: "COMMITTED",
    snapshots: tables.map((table) => ({
      table,
      ids:
        table === "families"
          ? ["1"]
          : table === "system_control_operations"
            ? ["aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"]
            : [],
      count: rows[table]!.length,
      digest: retiredDigest(rows[table]),
    })),
  };
  let committed = true,
    liveTable: string | undefined,
    liveSession = false;
  const connection = {
    query: async (sql: string) => {
      if (sql.includes("WHERE operation_id=?"))
        return [committed ? [{ id: "9" }] : []];
      if (sql.includes("SELECT COUNT(*) n FROM sessions"))
        return [[{ n: liveSession ? "1" : "0" }]];
      if (sql.includes("SELECT COUNT(*)"))
        return [
          [{ n: liveTable && sql.includes(`FROM ${liveTable} `) ? "1" : "0" }],
        ];
      const table = /FROM ([a-z_]+)/.exec(sql)?.[1];
      return [rows[table!] ?? []];
    },
  } as unknown as PoolConnection;
  const save = () => writeFileSync(file, JSON.stringify([record]));
  save();
  return {
    file,
    rows,
    record,
    connection,
    save,
    loseReceipt: () => {
      committed = false;
    },
    addLive: (table: string) => {
      liveTable = table;
    },
    addSession: () => {
      liveSession = true;
    },
  };
}
describe("strict test-only retired control evidence", () => {
  it("recognizes only committed exact identities while preserving the unknown outcome", async () => {
    const f = fixture();
    const result = await verifyRetiredControlFixtures(f.connection, f.file);
    expect([...result.families]).toEqual(["1"]);
    expect([...result.operations]).toEqual([
      "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
    ]);
    expect(f.rows.system_control_operations).toEqual([
      {
        id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
        status: "RECOVERY_REQUIRED",
        result_revision: null,
      },
    ]);
  });
  it("rejects prepared records", async () => {
    const f = fixture();
    f.record.status = "PREPARED";
    f.save();
    await expect(
      verifyRetiredControlFixtures(f.connection, f.file),
    ).rejects.toThrow("REGISTRY_INVALID");
  });
  it("rejects an unconfirmed commit", async () => {
    const f = fixture();
    f.loseReceipt();
    await expect(
      verifyRetiredControlFixtures(f.connection, f.file),
    ).rejects.toThrow("COMMIT_UNCONFIRMED");
  });
  it("rejects changed historical rows", async () => {
    const f = fixture();
    f.rows.system_control_operations = [
      {
        id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
        status: "APPLIED",
        result_revision: "1",
      },
    ];
    await expect(
      verifyRetiredControlFixtures(f.connection, f.file),
    ).rejects.toThrow("HISTORY_CHANGED");
  });
  it("rejects selectors outside the fixed schema", async () => {
    const f = fixture();
    f.record.snapshots[0]!.table = "toString";
    f.save();
    await expect(
      verifyRetiredControlFixtures(f.connection, f.file),
    ).rejects.toThrow("SELECTOR_INVALID");
  });
  it.each([
    "system_admin_grants",
    "invitations",
    "derived_assets",
    "upload_album_targets",
    "purge_intents",
  ])("rejects a surviving live %s", async (table) => {
    const f = fixture();
    f.addLive(table);
    await expect(
      verifyRetiredControlFixtures(f.connection, f.file),
    ).rejects.toThrow("LIVE_CAPABILITY_PRESENT");
  });
  it("rejects a surviving session", async () => {
    const f = fixture();
    f.addSession();
    await expect(
      verifyRetiredControlFixtures(f.connection, f.file),
    ).rejects.toThrow("LIVE_CAPABILITY_PRESENT");
  });
});
