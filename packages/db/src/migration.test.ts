import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const migrationPath = fileURLToPath(
  new URL("../drizzle/0000_phase_01a_identity_foundation.sql", import.meta.url),
);
const migration = readFileSync(migrationPath, "utf8");
const snapshot = JSON.parse(
  readFileSync(
    fileURLToPath(
      new URL("../drizzle/meta/0000_snapshot.json", import.meta.url),
    ),
    "utf8",
  ),
) as {
  tables: {
    invitations: {
      checkConstraint: Record<string, { name: string; value: string }>;
    };
  };
};

describe("Phase 1A versioned migration", () => {
  it("creates exactly the five reviewed InnoDB utf8mb4 tables", () => {
    expect(
      [...migration.matchAll(/CREATE TABLE `([^`]+)`/g)].map(
        (match) => match[1],
      ),
    ).toEqual([
      "families",
      "family_members",
      "invitations",
      "sessions",
      "users",
    ]);
    expect(migration.match(/ENGINE=InnoDB/g)).toHaveLength(5);
    expect(migration.match(/DEFAULT CHARACTER SET=utf8mb4/g)).toHaveLength(5);
  });

  it("uses precision-safe identifiers and exact binary credentials", () => {
    expect(migration.match(/bigint unsigned/g)?.length).toBeGreaterThanOrEqual(
      12,
    );
    expect(migration).toContain(
      "`username_normalized` varbinary(512) NOT NULL",
    );
    expect(migration.match(/`token_hash` binary\(32\) NOT NULL/g)).toHaveLength(
      2,
    );
    expect(migration).toContain("CHARACTER SET ascii COLLATE ascii_bin");
  });

  it("contains the reviewed unique, CHECK, and foreign-key boundaries", () => {
    expect(migration).toContain(
      "CONSTRAINT `uq_users_username_normalized` UNIQUE",
    );
    expect(migration).toContain(
      "CONSTRAINT `uq_invitations_token_hash` UNIQUE",
    );
    expect(migration).toContain("CONSTRAINT `uq_sessions_token_hash` UNIQUE");
    expect(migration.match(/ CHECK\(/g)).toHaveLength(7);
    expect(migration.match(/ FOREIGN KEY /g)).toHaveLength(7);
    expect(migration).toContain(
      "CONSTRAINT `chk_invitations_revoker_requires_revoked_at` CHECK(`invitations`.`revoked_by_member_id` IS NULL OR `invitations`.`revoked_at` IS NOT NULL)",
    );
    expect(
      snapshot.tables.invitations.checkConstraint
        .chk_invitations_revoker_requires_revoked_at,
    ).toEqual({
      name: "chk_invitations_revoker_requires_revoked_at",
      value:
        "`invitations`.`revoked_by_member_id` IS NULL OR `invitations`.`revoked_at` IS NOT NULL",
    });
    expect(migration).not.toContain(
      "SUPER_ADMIN','ADMIN','MEMBER') NOT NULL DEFAULT 'MEMBER',\n\t`token_hash`",
    );
  });

  it("does not hide drift or contain destructive database operations", () => {
    expect(migration).not.toMatch(/IF NOT EXISTS/i);
    expect(migration).not.toMatch(/DROP\s+(DATABASE|TABLE)/i);
    expect(migration).not.toMatch(/TRUNCATE/i);
  });
});
