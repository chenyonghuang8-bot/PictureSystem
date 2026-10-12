import { issueRunAdmissionProof } from "../../../packages/contracts/src/run-admission.js";
import { mkdtempSync, realpathSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { Pool, MySqlSystemControlRepository } from "@family-album/db";
import {
  CapacityGate,
  DerivedStore,
  StorageRoot,
  OriginalReader,
  OperationGate,
  DeploymentAdmission,
  ControlCoordinator,
} from "@family-album/storage";
import { StorageRuntimeOwner } from "./storage-runtime-owner.js";

async function fixture(
  test: (f: Awaited<ReturnType<typeof create>>) => Promise<void>,
) {
  const f = await create();
  try {
    await test(f);
  } finally {
    await f.owner.resources.close();
    rmSync(f.container, { recursive: true, force: true });
  }
}
async function create() {
  const container = mkdtempSync(join(realpathSync(tmpdir()), "phase11-owner-"));
  const mediaRoot = join(container, "r");
  const root = StorageRoot.open(mediaRoot, { initialize: true });
  mkdirSync(join(mediaRoot, "derived"), { mode: 0o700 });
  root.provisionDerivedWriterLockForDev();
  root.provisionSharedCapacityLockForDev();
  const gate = CapacityGate.open({
    mediaRoot,
    expectedMarkerId: root.markerId,
  });
  const store = DerivedStore.open({ state: "READ_WRITE", root });
  const reader = OriginalReader.open({
    mediaRoot,
    expectedMarkerId: root.markerId,
  });
  const namespace = {
    path: join(container, "control"),
    deploymentId: randomUUID(),
  };
  mkdirSync(namespace.path, { mode: 0o700 });
  const controlGate = OperationGate.provisionDev(namespace);
  const s = await controlGate.acquire("S", 0);
  const identity = s.identity();
  s.close();
  const admission = new DeploymentAdmission(controlGate, async () => ({
    runProof: issueRunAdmissionProof({
      runId: randomUUID(),
      epoch: "1",
      processId: randomUUID(),
    }),
    deploymentId: namespace.deploymentId,
    namespaceIdentity: identity,
    revision: "2",
    healthGeneration: "1",
    requestedMode: "READ_ONLY",
    enforcedMode: "READ_ONLY",
    transitionState: "RESUMING",
    faultLatched: true,
  }));
  const pending = {
    control: {
      revision: "2",
      healthGeneration: "1",
      namespaceIdentity: identity,
      transitionState: "RESUMING",
      activeOperationId: randomUUID(),
    },
    operation: { operationId: "" },
  };
  pending.operation.operationId = pending.control.activeOperationId;
  const repository = {
    participantsReady: vi.fn(async () => true),
    verifyRecoveryInventory: vi.fn(
      async (inventory: {
        complete: boolean;
        temps: unknown[];
        finals: unknown[];
      }) =>
        inventory.complete &&
        inventory.temps.length === 0 &&
        inventory.finals.length === 0,
    ),
    storageObservation: vi.fn(async () => ({
      reservedFutureBytes: 0n,
      unsettledBytes: 0n,
      unsettledPurges: 0n,
    })),
  };
  const recoverOriginal = vi.fn(async () => true),
    complete = vi.fn(async () => {}),
    latch = vi.fn(async () => {});
  const owner = new StorageRuntimeOwner(
    { capability: { state: "READ_WRITE", root }, gate, store, reader },
    {
      query: vi.fn(async () => [[]]),
      getConnection: async () => ({
        query: async (sql: string) => {
          if (sql.includes("AS nativeFk"))
            return [[{ nativeFk: 1, foreignKeyChecks: 1 }]];
          if (sql.includes("AS sqlMode"))
            return [[{ timeZone: "+00:00", sqlMode: "STRICT_TRANS_TABLES" }]];
          if (sql.includes("AS serverNow"))
            return [[{ serverNow: new Date() }]];
          return [[]];
        },
        beginTransaction: async () => {},
        execute: async () => [[]],
        commit: async () => {},
        rollback: async () => {},
        release: () => {},
        destroy: () => {},
      }),
    } as unknown as Pool,
    repository as unknown as MySqlSystemControlRepository,
    { mediaRoot, markerId: root.markerId, roles: ["API"] },
    recoverOriginal,
  );
  const coordinator = new ControlCoordinator(
    controlGate,
    admission,
    { pending: async () => pending, complete, latch },
    owner,
  );
  return {
    container,
    mediaRoot,
    root,
    reader,
    store,
    gate,
    owner,
    coordinator,
    repository,
    complete,
    recoverOriginal,
    latch,
    admission,
  };
}
describe("actual native owner generation during fenced recovery", () => {
  it("closes all old capabilities before reopening the existing unique writer and proving an empty inventory", async () =>
    fixture(async (f) => {
      const competing = () =>
        StorageRoot.open(f.mediaRoot, {
          initialize: false,
          expectedMarkerId: f.root.markerId,
        });
      expect(competing).toThrow();
      await f.coordinator.tick();
      expect(f.owner.resources.generation()).toBe("2");
      expect(() => f.root.assertIdentity()).toThrow();
      expect(() => f.reader.assertIdentity()).toThrow();
      expect(f.complete).toHaveBeenCalledOnce();
      await f.owner.health();
      expect(competing).toThrow();
    }));
  it("a stale participant never closes the original owner or reports completion", async () =>
    fixture(async (f) => {
      f.repository.participantsReady.mockResolvedValue(false);
      await f.coordinator.tick();
      expect(f.owner.resources.generation()).toBe("1");
      f.root.assertIdentity();
      expect(f.recoverOriginal).not.toHaveBeenCalled();
      expect(f.complete).not.toHaveBeenCalled();
    }));
  it("unresolved accounting keeps the operation protected after native reopen", async () =>
    fixture(async (f) => {
      f.repository.verifyRecoveryInventory.mockResolvedValue(false);
      await f.coordinator.tick();
      expect(f.owner.resources.generation()).toBe("2");
      expect(f.complete).not.toHaveBeenCalled();
      await expect(
        f.admission.run("MEDIA_WRITE", async () => {}),
      ).rejects.toThrow("WRITE_PAUSED");
    }));
  it("an active read callback prevents close/reopen and completion", async () =>
    fixture(async (f) => {
      let release!: () => void;
      const held = f.owner.resources.withValue(
        () =>
          new Promise<void>((r) => {
            release = r;
          }),
      );
      const round = f.coordinator.tick();
      await new Promise((r) => setTimeout(r, 20));
      expect(f.complete).not.toHaveBeenCalled();
      f.root.assertIdentity();
      release();
      await held;
      await round;
      expect(f.complete).toHaveBeenCalledOnce();
    }));
});
