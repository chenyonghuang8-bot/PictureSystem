import { describe, expect, it, vi } from "vitest";
import type { Pool } from "mysql2/promise";
import { MySqlSystemControlRepository } from "./system-control-repository.js";
import type {
  DerivedRecoveryFinalFact,
  DerivedRecoveryTempFact,
} from "./derived-recovery.js";
const row = {
  familyId: "1",
  mediaId: "2",
  generation: "3",
  recipeId: 1,
  kind: "PREVIEW",
  state: "READY",
  byteSize: "8",
  sha256Hex: "a".repeat(64),
  jobId: "4",
  epoch: "5",
  reservedBytes: "100",
};
const final: DerivedRecoveryFinalFact = {
  familyId: "1",
  mediaId: "2",
  generation: 3n,
  recipeId: 1,
  kind: "PREVIEW",
  byteSize: 8n,
  sha256Hex: "a".repeat(64),
  fileClass: "REGULAR",
  mode: 0o400,
  nlink: 1,
  device: "6",
  inode: "7",
};
const temp: DerivedRecoveryTempFact = {
  jobId: "4",
  epoch: 5n,
  kind: "PREVIEW",
  byteSize: 8n,
  sha256Hex: "a".repeat(64),
  fileClass: "REGULAR",
  mode: 0o600,
  nlink: 1,
  device: "6",
  inode: "7",
};
function fixture(
  assets: object[],
  pending = { runningJobs: "0", purges: "0" },
) {
  const c = {
    query: vi.fn(async (sql: string) => {
      if (sql.includes("AS nativeFk"))
        return [[{ nativeFk: 1, foreignKeyChecks: 1 }]];
      if (sql.includes("AS sqlMode"))
        return [[{ timeZone: "+00:00", sqlMode: "STRICT_TRANS_TABLES" }]];
      if (sql.includes("FROM derived_assets")) return [assets];
      if (sql.includes("runningJobs")) return [[pending]];
      return [[]];
    }),
    commit: vi.fn(async () => {}),
    rollback: vi.fn(async () => {}),
    destroy: vi.fn(),
    release: vi.fn(),
  };
  const repository = new MySqlSystemControlRepository({
    getConnection: async () => c,
  } as unknown as Pool);
  return {
    c,
    run: (
      temps: DerivedRecoveryTempFact[] = [],
      finals: DerivedRecoveryFinalFact[] = [final],
    ) => repository.verifyRecoveryInventory({ complete: true, temps, finals }),
  };
}
describe("fenced recovery inventory proof", () => {
  it("requires the complete READY final identity and a read-only consistent snapshot", async () => {
    const { c, run } = fixture([row]);
    expect(await run()).toBe(true);
    expect(c.query).toHaveBeenCalledWith(
      "START TRANSACTION READ ONLY, WITH CONSISTENT SNAPSHOT",
    );
    expect(
      c.query.mock.calls.every(([sql]) => !sql.includes("FOR UPDATE")),
    ).toBe(true);
    expect(c.commit).toHaveBeenCalledOnce();
    expect(c.release).toHaveBeenCalledOnce();
  });
  it("missing files and unbound files cannot be interpreted as resolved accounting", async () => {
    expect(await fixture([row]).run([], [])).toBe(false);
    expect(await fixture([]).run()).toBe(false);
  });
  it.each([
    { ...final, sha256Hex: "b".repeat(64) },
    { ...final, byteSize: 9n },
    { ...final, mode: 0o600 },
    { ...final, nlink: 2 },
    { ...final, generation: 4n },
    { ...final, fileClass: "SYMLINK" as const },
  ])("refuses changed final evidence %#", async (fact) => {
    expect(await fixture([row]).run([], [fact])).toBe(false);
  });
  it.each(["RESERVED", "PUBLISHING", "FAILED"])(
    "does not invent READY from %s",
    async (state) => {
      expect(await fixture([{ ...row, state }]).run()).toBe(false);
    },
  );
  it("rejects duplicates instead of accepting a truncated or ambiguous set", async () => {
    expect(await fixture([row]).run([], [final, final])).toBe(false);
  });
  it.each([
    { runningJobs: "1", purges: "0" },
    { runningJobs: "0", purges: "1" },
  ])(
    "unsettled work requires the original checkpoint protocol %#",
    async (pending) => {
      expect(await fixture([row], pending).run()).toBe(false);
    },
  );
  it("known bound unsealed temp remains charged, but sealed output is still protected", async () => {
    const reserved = {
      ...row,
      state: "RESERVED",
      byteSize: null,
      sha256Hex: null,
    };
    expect(await fixture([reserved]).run([temp], [])).toBe(true);
    expect(await fixture([reserved]).run([{ ...temp, mode: 0o400 }], [])).toBe(
      false,
    );
    expect(
      await fixture([reserved]).run([{ ...temp, byteSize: 101n }], []),
    ).toBe(false);
  });
});
