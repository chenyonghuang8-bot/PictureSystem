import { getTableConfig } from "drizzle-orm/mysql-core";
import { describe, expect, it } from "vitest";

import { databaseConnectionDefaults } from "./index.js";
import {
  families,
  familyMembers,
  invitations,
  sessions,
  users,
} from "./schema.js";

const tables = [users, families, familyMembers, invitations, sessions] as const;

describe("Phase 1A Drizzle schema", () => {
  it("contains only the five reviewed business tables", () => {
    expect(tables.map((table) => getTableConfig(table).name)).toEqual([
      "users",
      "families",
      "family_members",
      "invitations",
      "sessions",
    ]);
  });

  it("maps all identifiers as unsigned bigint rather than JS number", () => {
    for (const table of tables) {
      const idColumn = getTableConfig(table).columns.find(
        (column) => column.name === "id",
      );
      expect(idColumn?.getSQLType()).toBe("bigint unsigned");
      expect(idColumn?.dataType).toBe("bigint");
    }
    expect(databaseConnectionDefaults).toMatchObject({
      supportBigNumbers: true,
      bigNumberStrings: true,
      multipleStatements: false,
      timezone: "Z",
    });
  });

  it("uses full binary unique indexes for usernames and token hashes", () => {
    expect(users.usernameNormalized.getSQLType()).toBe("varbinary(512)");
    expect(invitations.tokenHash.getSQLType()).toBe("binary(32)");
    expect(sessions.tokenHash.getSQLType()).toBe("binary(32)");

    const input = Buffer.alloc(32, 0xab);
    expect(sessions.tokenHash.mapToDriverValue(input)).toEqual(input);
    expect(sessions.tokenHash.mapFromDriverValue(input)).toEqual(input);
    expect(() =>
      sessions.tokenHash.mapToDriverValue(Buffer.alloc(31)),
    ).toThrow();

    expect(
      getTableConfig(users).indexes.map((item) => item.config.name),
    ).toContain("uq_users_username_normalized");
    expect(
      getTableConfig(invitations).indexes.map((item) => item.config.name),
    ).toContain("uq_invitations_token_hash");
    expect(
      getTableConfig(sessions).indexes.map((item) => item.config.name),
    ).toContain("uq_sessions_token_hash");
  });

  it("defines reviewed CHECK and foreign-key constraints", () => {
    expect(getTableConfig(invitations).checks.map((item) => item.name)).toEqual(
      [
        "chk_invitations_expiry",
        "chk_invitations_used_pair",
        "chk_invitations_used_or_revoked",
        "chk_invitations_revoker_requires_revoked_at",
      ],
    );
    expect(getTableConfig(sessions).checks.map((item) => item.name)).toEqual([
      "chk_sessions_expiry",
      "chk_sessions_last_seen",
      "chk_sessions_revoked_pair",
    ]);
    expect(getTableConfig(invitations).foreignKeys).toHaveLength(4);
    expect(getTableConfig(sessions).foreignKeys).toHaveLength(1);
  });

  it("does not permit SUPER_ADMIN invitations or role snapshots in sessions", () => {
    expect(invitations.role.enumValues).toEqual(["ADMIN", "MEMBER"]);
    expect(familyMembers.role.enumValues).toEqual([
      "SUPER_ADMIN",
      "ADMIN",
      "MEMBER",
    ]);
    expect(
      getTableConfig(sessions).columns.map((column) => column.name),
    ).not.toContain("role");
  });
});
