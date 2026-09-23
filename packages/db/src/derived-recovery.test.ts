import { describe, expect, it } from "vitest";

import {
  classifyDerivedRecoveryCase,
  type DerivedRecoveryFinalFact,
  type DerivedRecoveryRow,
  type DerivedRecoveryTempFact,
} from "./derived-recovery.js";

function row(overrides: Partial<DerivedRecoveryRow> = {}): DerivedRecoveryRow {
  return {
    id: "9",
    familyId: "7",
    mediaId: "8",
    generation: 3n,
    recipeId: 1,
    kind: "THUMBNAIL",
    state: "RESERVED",
    reservedBytes: 524288n,
    byteSize: null,
    sha256Hex: null,
    producerJobId: "42",
    producerLeaseEpoch: 5n,
    cleanedAt: null,
    ...overrides,
  };
}

function temp(
  overrides: Partial<DerivedRecoveryTempFact> = {},
): DerivedRecoveryTempFact {
  return {
    jobId: "42",
    epoch: 5n,
    kind: "THUMBNAIL",
    byteSize: 4n,
    device: "1",
    inode: "2",
    mode: 0o600,
    nlink: 1,
    sha256Hex: "ab".repeat(32),
    fileClass: "REGULAR",
    ...overrides,
  };
}

function final(
  overrides: Partial<DerivedRecoveryFinalFact> = {},
): DerivedRecoveryFinalFact {
  return {
    familyId: "7",
    mediaId: "8",
    generation: 3n,
    recipeId: 1,
    kind: "THUMBNAIL",
    byteSize: 4n,
    device: "1",
    inode: "9",
    mode: 0o400,
    nlink: 1,
    sha256Hex: "cd".repeat(32),
    fileClass: "REGULAR",
    ...overrides,
  };
}

describe("derived publish recovery classification", () => {
  it("keeps a live temp reservation and does not treat it as ready", () => {
    expect(
      classifyDerivedRecoveryCase({
        capability: "READ_WRITE",
        inventoryComplete: true,
        temp: temp(),
        final: null,
        row: row(),
        leaseCurrent: true,
      }),
    ).toBe("TEMP_ONLY_RETAIN");
  });

  it("keeps a sealed temp as a candidate", () => {
    expect(
      classifyDerivedRecoveryCase({
        capability: "READ_WRITE",
        inventoryComplete: true,
        temp: temp({ mode: 0o400 }),
        final: null,
        row: row(),
        leaseCurrent: false,
      }),
    ).toBe("SEALED_CANDIDATE");
  });

  it("does not adopt an unknown temp or an unbound final", () => {
    expect(
      classifyDerivedRecoveryCase({
        capability: "READ_WRITE",
        inventoryComplete: true,
        temp: temp(),
        final: null,
        row: null,
        leaseCurrent: false,
      }),
    ).toBe("UNKNOWN_RESIDUE");
    expect(
      classifyDerivedRecoveryCase({
        capability: "READ_WRITE",
        inventoryComplete: true,
        temp: null,
        final: final(),
        row: null,
        leaseCurrent: false,
      }),
    ).toBe("UNBOUND_FINAL");
  });

  it("reports a final that exists while the row is still reserved", () => {
    expect(
      classifyDerivedRecoveryCase({
        capability: "READ_WRITE",
        inventoryComplete: true,
        temp: null,
        final: final(),
        row: row(),
        leaseCurrent: false,
      }),
    ).toBe("PUBLISH_BEFORE_DB");
  });

  it("reports conflict instead of overwrite", () => {
    expect(
      classifyDerivedRecoveryCase({
        capability: "READ_WRITE",
        inventoryComplete: true,
        temp: temp(),
        final: final(),
        row: row(),
        leaseCurrent: false,
      }),
    ).toBe("FINAL_CONFLICT");
    expect(
      classifyDerivedRecoveryCase({
        capability: "READ_WRITE",
        inventoryComplete: true,
        temp: null,
        final: final({ sha256Hex: "ef".repeat(32) }),
        row: row({ sha256Hex: "cd".repeat(32), state: "PUBLISHING" }),
        leaseCurrent: false,
      }),
    ).toBe("FINAL_CONFLICT");
  });

  it("fails closed on unknown commit, identity drift, symlink, and read-only", () => {
    expect(
      classifyDerivedRecoveryCase({
        capability: "READ_WRITE",
        inventoryComplete: true,
        temp: temp(),
        final: null,
        row: "UNKNOWN",
        leaseCurrent: false,
      }),
    ).toBe("COMMIT_UNKNOWN");
    expect(
      classifyDerivedRecoveryCase({
        capability: "READ_WRITE",
        inventoryComplete: true,
        temp: temp({ sha256Hex: "zz" }),
        final: null,
        row: row(),
        leaseCurrent: false,
      }),
    ).toBe("RECOVERY_REQUIRED");
    expect(
      classifyDerivedRecoveryCase({
        capability: "READ_WRITE",
        inventoryComplete: true,
        temp: temp({ mode: 0o644 }),
        final: null,
        row: row(),
        leaseCurrent: false,
      }),
    ).toBe("RECOVERY_REQUIRED");
    expect(
      classifyDerivedRecoveryCase({
        capability: "READ_WRITE",
        inventoryComplete: true,
        temp: temp({ fileClass: "SYMLINK" }),
        final: null,
        row: row(),
        leaseCurrent: false,
      }),
    ).toBe("SYMLINK");
    expect(
      classifyDerivedRecoveryCase({
        capability: "READ_ONLY",
        inventoryComplete: true,
        temp: temp(),
        final: null,
        row: row(),
        leaseCurrent: false,
      }),
    ).toBe("READ_ONLY_REPORT");
    expect(
      classifyDerivedRecoveryCase({
        capability: "READ_WRITE",
        inventoryComplete: false,
        temp: temp(),
        final: null,
        row: row(),
        leaseCurrent: false,
      }),
    ).toBe("INVENTORY_INCOMPLETE");
  });
});
