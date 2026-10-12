import { issueRunAdmissionProof } from "@family-album/contracts/internal/run-admission";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { describe, it, expect, vi } from "vitest";
import { OperationGate } from "./operation-gate.js";
import { DeploymentAdmission } from "./control-admission.js";
import {
  ControlCoordinator,
  type PendingControlCommand,
} from "./control-coordinator.js";
async function fixture(
  run: (input: {
    gate: OperationGate;
    admission: DeploymentAdmission;
    pending: PendingControlCommand;
  }) => Promise<void>,
) {
  const path = mkdtempSync(
    join(realpathSync(tmpdir()), "phase11-coordinator-"),
  );
  const namespace = { path, deploymentId: randomUUID() },
    gate = OperationGate.provisionDev(namespace);
  const s = await gate.acquire("S", 0),
    identity = s.identity();
  s.close();
  const admission = new DeploymentAdmission(gate, async () => ({
    runProof: issueRunAdmissionProof({
      runId: randomUUID(),
      epoch: "1",
      processId: randomUUID(),
    }),
    deploymentId: namespace.deploymentId,
    namespaceIdentity: identity,
    requestedMode: "NORMAL",
    enforcedMode: "NORMAL",
    transitionState: "STABLE",
    revision: "1",
    healthGeneration: "1",
    faultLatched: false,
  }));
  const pending = {
    control: {
      revision: "2",
      healthGeneration: "1",
      namespaceIdentity: identity,
      transitionState: "DRAINING",
      activeOperationId: randomUUID(),
    },
    operation: { operationId: randomUUID() },
  };
  pending.control.activeOperationId = pending.operation.operationId;
  try {
    await run({ gate, admission, pending });
  } finally {
    rmSync(path, { recursive: true, force: true });
  }
}
describe("native fenced control coordinator ordering", () => {
  it("never mints a drained recovery capability from the latch mutex", async () =>
    fixture(async ({ gate }) => {
      const latch = await gate.acquireLatch(0);
      expect(latch.drained).toBe(false);
      latch.close();
    }));
  it("keeps recovery pending when current participants are not ready", async () =>
    fixture(async ({ gate, admission, pending }) => {
      pending.control.transitionState = "RESUMING";
      const l = await gate.acquireLatch(0),
        marker = l.latchDeny("PARTICIPANT_STALE");
      l.close();
      const complete = vi.fn(async () => {}),
        recover = vi.fn(async () => "NOT_READY" as const);
      const coordinator = new ControlCoordinator(
        gate,
        admission,
        { pending: async () => pending, complete, latch: async () => {} },
        { recover },
      );
      await coordinator.tick();
      await coordinator.tick();
      expect(recover).toHaveBeenCalledTimes(2);
      expect(complete).not.toHaveBeenCalled();
      const s = await gate.acquire("S", 0);
      expect(s.readDeny()).toEqual(marker);
      s.close();
    }));
  it("creates durable protection when the raw drain proof rejects a corrupt bridge", async () =>
    fixture(async ({ gate, admission, pending }) => {
      const { writeFileSync } = await import("node:fs");
      writeFileSync(
        join(gate.namespace.path, `bridge.${"a".repeat(32)}`),
        "corrupt",
        { mode: 0o600 },
      );
      const complete = vi.fn(async () => {}),
        latch = vi.fn(async () => {});
      const coordinator = new ControlCoordinator(
        gate,
        admission,
        { pending: async () => pending, complete, latch },
        { recover: async () => {} },
      );
      await expect(coordinator.tick()).rejects.toMatchObject({
        code: "OPERATION_BRIDGE_UNKNOWN",
      });
      expect(complete).not.toHaveBeenCalled();
      expect(latch).toHaveBeenCalledOnce();
      expect(admission.isLocallyDenied()).toBe(true);
      const s = await gate.acquire("S", 0);
      expect(s.readDeny()?.reasonCode).toBe("RECOVERY_FAILED");
      s.close();
    }));
  it("retries only the same health latch event after DB failure", async () =>
    fixture(async ({ gate, admission }) => {
      const events: string[] = [];
      const coordinator = new ControlCoordinator(
        gate,
        admission,
        {
          pending: async () => null,
          complete: async () => {},
          latch: async (_reason, id) => {
            events.push(id);
            if (events.length === 1) throw Error("DB_UNAVAILABLE");
          },
        },
        { recover: async () => {} },
      );
      await expect(coordinator.trip("DB_UNAVAILABLE")).rejects.toThrow(
        "DB_UNAVAILABLE",
      );
      await coordinator.tick();
      expect(events).toHaveLength(2);
      expect(events[0]).toBe(events[1]);
      const s = await gate.acquire("S", 0);
      expect(s.readDeny()?.reasonCode).toBe("DB_UNAVAILABLE");
      s.close();
    }));
  it("waits for the actual in-flight S unit after request observation before applying", async () =>
    fixture(async ({ gate, admission, pending }) => {
      let entered!: () => void, release!: () => void;
      const started = new Promise<void>((r) => (entered = r)),
        settled = new Promise<void>((r) => (release = r));
      const unit = admission.run("MEDIA_WRITE", async () => {
        entered();
        await settled;
      });
      await started;
      const complete = vi.fn(async () => {}),
        repository = {
          pending: async () => pending,
          complete,
          latch: vi.fn(async () => {}),
        };
      const coordinator = new ControlCoordinator(gate, admission, repository, {
        recover: async () => {
          throw Error("NO_RECOVERY");
        },
      });
      const round = coordinator.tick();
      await delay(15);
      expect(complete).not.toHaveBeenCalled();
      release();
      await unit;
      await round;
      expect(complete).toHaveBeenCalledExactlyOnceWith(pending, null);
    }));
  it("preserves native protection after unknown completion and never replays that operation", async () =>
    fixture(async ({ gate, admission, pending }) => {
      pending.control.transitionState = "RESUMING";
      const latch = await gate.acquireLatch(0);
      const marker = latch.latchDeny("DB_UNAVAILABLE");
      latch.close();
      admission.denyLocally();
      const complete = vi.fn(async () => {
        throw Error("COMMIT_OUTCOME_UNKNOWN");
      });
      const repository = {
        pending: async () => pending,
        complete,
        latch: vi.fn(async () => {}),
      };
      const coordinator = new ControlCoordinator(gate, admission, repository, {
        recover: async (p) => {
          await p.run("STARTUP_ASSESS", async () => {});
        },
      });
      await expect(coordinator.tick()).rejects.toThrow(
        "COMMIT_OUTCOME_UNKNOWN",
      );
      await coordinator.tick();
      expect(complete).toHaveBeenCalledTimes(1);
      const s = await gate.acquire("S", 0);
      expect(s.readDeny()).toEqual(marker);
      s.close();
      expect(admission.isLocallyDenied()).toBe(true);
    }));
  it("refuses marker clear if a new local health generation arrives during final commit", async () =>
    fixture(async ({ gate, admission, pending }) => {
      pending.control.transitionState = "RESUMING";
      const l = await gate.acquireLatch(0),
        marker = l.latchDeny("DB_UNAVAILABLE");
      l.close();
      admission.denyLocally();
      const coordinator = new ControlCoordinator(
        gate,
        admission,
        {
          pending: async () => pending,
          complete: async () => {
            admission.denyLocally();
          },
          latch: async () => {},
        },
        { recover: async () => {} },
      );
      await expect(coordinator.tick()).rejects.toThrow("HEALTH_CHANGED");
      const s = await gate.acquire("S", 0);
      expect(s.readDeny()).toEqual(marker);
      s.close();
    }));
  it("rejects a normal S claim from fenced recovery instead of waiting on itself", async () =>
    fixture(async ({ gate, admission, pending }) => {
      pending.control.transitionState = "RESUMING";
      const complete = vi.fn(async () => {});
      const coordinator = new ControlCoordinator(
        gate,
        admission,
        { pending: async () => pending, complete, latch: async () => {} },
        {
          recover: async (p) => {
            await p.run("CANONICAL_RECONCILE", () =>
              admission.run("MEDIA_WRITE", async () => {}),
            );
          },
        },
      );
      await expect(coordinator.tick()).rejects.toThrow("CONTROL_UNAVAILABLE");
      expect(complete).not.toHaveBeenCalled();
    }));
});
