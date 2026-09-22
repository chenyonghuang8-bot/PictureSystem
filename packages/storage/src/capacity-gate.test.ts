import {
  chmodSync,
  mkdtempSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { CapacityGate, StorageRoot } from "./index.js";

describe("shared root-bound capacity gate", () => {
  it("requires explicit provision and serializes independent handles", async () => {
    const rootPath = mkdtempSync(
      join(realpathSync(tmpdir()), "phase4d3b0-capacity-"),
    );
    const root = StorageRoot.open(rootPath, { initialize: true });
    let first: CapacityGate | undefined;
    let second: CapacityGate | undefined;
    try {
      expect(() =>
        CapacityGate.open({
          mediaRoot: rootPath,
          expectedMarkerId: root.markerId,
        }),
      ).toThrow();
      root.provisionSharedCapacityLockForDev();
      first = CapacityGate.open({
        mediaRoot: rootPath,
        expectedMarkerId: root.markerId,
      });
      second = CapacityGate.open({
        mediaRoot: rootPath,
        expectedMarkerId: root.markerId,
      });
      const order: string[] = [];
      await Promise.all([
        first.withLock(async (capacity) => {
          expect(capacity.availableBytes).toBeGreaterThan(0n);
          order.push("first-enter");
          await new Promise((resolve) => setTimeout(resolve, 35));
          order.push("first-exit");
        }),
        second.withLock(async () => {
          order.push("second-enter");
        }),
      ]);
      expect(order).toEqual(["first-enter", "first-exit", "second-enter"]);
      expect(() => root.provisionSharedCapacityLockForDev()).toThrow();
    } finally {
      second?.close();
      first?.close();
      root.close();
      rmSync(rootPath, { recursive: true, force: true });
    }
  });

  it("rejects a replaced lock inode and symlink without recreating it", async () => {
    const rootPath = mkdtempSync(
      join(realpathSync(tmpdir()), "phase4d3b0-capacity-"),
    );
    const root = StorageRoot.open(rootPath, { initialize: true });
    let gate: CapacityGate | undefined;
    try {
      root.provisionSharedCapacityLockForDev();
      gate = CapacityGate.open({
        mediaRoot: rootPath,
        expectedMarkerId: root.markerId,
      });
      renameSync(
        join(rootPath, ".capacity.lock"),
        join(rootPath, ".capacity.lock.old"),
      );
      symlinkSync(".capacity.lock.old", join(rootPath, ".capacity.lock"));
      await expect(gate.withLock(async () => undefined)).rejects.toThrow();
      expect(() =>
        CapacityGate.open({
          mediaRoot: rootPath,
          expectedMarkerId: root.markerId,
        }),
      ).toThrow();
    } finally {
      gate?.close();
      root.close();
      rmSync(rootPath, { recursive: true, force: true });
    }
  });

  it("rejects non-0600 lock mode", () => {
    const rootPath = mkdtempSync(
      join(realpathSync(tmpdir()), "phase4d3b0-capacity-"),
    );
    const root = StorageRoot.open(rootPath, { initialize: true });
    try {
      root.provisionSharedCapacityLockForDev();
      chmodSync(join(rootPath, ".capacity.lock"), 0o640);
      expect(() =>
        CapacityGate.open({
          mediaRoot: rootPath,
          expectedMarkerId: root.markerId,
        }),
      ).toThrow();
    } finally {
      root.close();
      rmSync(rootPath, { recursive: true, force: true });
    }
  });

  it("includes the local queue in the total two-second admission deadline", async () => {
    const rootPath = mkdtempSync(
      join(realpathSync(tmpdir()), "phase4d3b0-capacity-"),
    );
    const root = StorageRoot.open(rootPath, { initialize: true });
    let first: CapacityGate | undefined;
    let second: CapacityGate | undefined;
    try {
      root.provisionSharedCapacityLockForDev();
      first = CapacityGate.open({
        mediaRoot: rootPath,
        expectedMarkerId: root.markerId,
      });
      second = CapacityGate.open({
        mediaRoot: rootPath,
        expectedMarkerId: root.markerId,
      });
      let signalEntered!: () => void;
      const entered = new Promise<void>((resolve) => {
        signalEntered = resolve;
      });
      const firstAdmission = first.withLock(async () => {
        signalEntered();
        await new Promise<void>((resolveDelay) =>
          setTimeout(resolveDelay, 2_100),
        );
      });
      void firstAdmission.catch(() => undefined);
      await entered;
      let secondEntered = false;
      const secondAdmission = second.withLock(async () => {
        secondEntered = true;
      });
      await expect(secondAdmission).rejects.toThrow();
      await expect(firstAdmission).rejects.toThrow();
      expect(secondEntered).toBe(false);
    } finally {
      second?.close();
      first?.close();
      root.close();
      rmSync(rootPath, { recursive: true, force: true });
    }
  });
});
