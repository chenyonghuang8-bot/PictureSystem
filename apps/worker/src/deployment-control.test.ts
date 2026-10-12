import { issueRunAdmissionProof } from "../../../packages/contracts/src/run-admission.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  type MySqlSystemRunRepository,
  type RunLease,
  type RunConfiguration,
  type RunProcess,
  type RunMember,
  type MySqlSystemControlRepository,
  SystemControlError,
} from "@family-album/db";
import type { OperationGate } from "@family-album/storage";
import {
  ManagedControl,
  configuredControlRoles,
} from "./deployment-control.js";
import { adminReasonSchema } from "../../../packages/contracts/src/admin.js";

function fixture() {
  let marker: { token: string; reasonCode: string } | null = null;
  const current = {
    deploymentId: "fixture",
    namespaceIdentity: "bound",
    requestedMode: "NORMAL",
    enforcedMode: "NORMAL",
    transitionState: "STABLE",
    revision: "7",
    healthGeneration: "1",
    faultLatched: false,
  };
  const lock = {
    identity: () => "bound",
    readDeny: () => marker,
    close: vi.fn(),
    latchDeny: (reason: string) =>
      (marker ??= { token: "fixture-token", reasonCode: reason }),
    run: <T>(f: () => Promise<T>) => f(),
    registerRunOwner: (processId: string) => ({
      processId,
      osBootId: "fixture",
      pid: 1,
      startSec: "1",
      startUsec: 0,
    }),
    recoverBridges: vi.fn(),
    drained: true,
  };
  const gate = {
    namespace: { deploymentId: "fixture" },
    acquireRun: async () => lock,
    runIdentity: () => "bound",
    verifyRunOwner: () => true,
    acquire: async () => lock,
    acquireLatch: async () => lock,
  } as unknown as OperationGate;
  const repository = {
    readCurrent: vi.fn(async () => current),
    runtimeRegister: vi.fn(
      async (_role: string, _boot: string, _revision: string) => {
        void _role;
        void _boot;
        void _revision;
      },
    ),
    runtimeBeat: vi.fn(
      async (_role: string, _boot: string, input: { reasonCode: string }) => {
        void _role;
        void _boot;
        adminReasonSchema.parse(input.reasonCode);
        return true;
      },
    ),
    pending: vi.fn(async () => null),
    complete: vi.fn(async () => {}),
    latch: vi.fn(async () => {}),
  };
  let lease: RunLease;
  // Explicit isolated unit dependency; integration always uses native/SQL registration.
  const runs = {
    begin: async (
      configuration: RunConfiguration,
      process: RunProcess,
      members: readonly RunMember[],
    ) =>
      (lease = {
        id: "unit-run",
        epoch: "1",
        automatic: true,
        configuration,
        process,
        members,
      }),
    readAdmission: async () => ({
      ...current,
      ...(lease
        ? {
            runProof: issueRunAdmissionProof({
              runId: lease.id,
              epoch: lease.epoch,
              processId: lease.process.processId,
            }),
          }
        : {}),
    }),
    join: async (
      configuration: RunConfiguration,
      process: RunProcess,
      members: readonly RunMember[],
    ) =>
      (lease = {
        id: "unit-run",
        epoch: "1",
        automatic: true,
        configuration,
        process,
        members,
      }),
    observeCurrent: async () => ({
      id: lease?.id ?? "unit-run",
      phase: "ACTIVE",
    }),
    ready: async () => {},
    requireRecovery: async () => {},
    phase: async () => "ACTIVE",
    stopping: async () => {},
    acknowledge: async () => {},
    clean: async () => true,
  } as unknown as MySqlSystemRunRepository;
  const runtime = new ManagedControl(
    gate,
    repository as unknown as MySqlSystemControlRepository,
    runs,
  );
  const control = runtime.public(true);
  return {
    gate,
    lock,
    current,
    repository,
    runtime,
    runs,
    control,
    readMarker: () => marker,
    clearSharedMarker: () => {
      marker = null;
    },
  };
}
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});
describe("deployment runtime observations and owner health", () => {
  it("keeps an already protected empty owner denied while allowing its next fresh recovery", async () => {
    const { control, current, repository, runs } = fixture();
    current.enforcedMode = "READ_ONLY";
    current.requestedMode = "READ_ONLY";
    current.transitionState = "RECOVERY_REQUIRED";
    current.faultLatched = true;
    vi.spyOn(runs, "phase").mockResolvedValue("RECOVERY_REQUIRED");
    control.bindOwner!({
      ready: () => true,
      health: async () => {
        throw Error("OWNER_NOT_READY");
      },
      recover: async () => {},
      changing: () => false,
    });
    await control.start!([{ role: "API", ready: () => true }]);
    expect(repository.latch).not.toHaveBeenCalled();
    await expect(
      control.admission.run("MEDIA_WRITE", async () => true),
    ).rejects.toMatchObject({ reason: "WRITE_PAUSED" });
    await control.drain!();
  });
  it("still latches an empty owner when its run is ACTIVE and control is writable", async () => {
    const { control, repository } = fixture();
    control.bindOwner!({
      ready: () => true,
      health: async () => {
        throw Error("OWNER_NOT_READY");
      },
      recover: async () => {},
      changing: () => false,
    });
    await control.start!([{ role: "API", ready: () => true }]);
    expect(repository.latch).toHaveBeenCalledWith(
      "STORAGE_UNAVAILABLE",
      expect.any(String),
    );
    await expect(
      control.admission.run("MEDIA_WRITE", async () => true),
    ).rejects.toMatchObject({ reason: "WRITE_PAUSED" });
    await control.drain!();
  });
  it("retains the original run owner while an existing S unit delays CLEAN", async () => {
    const { control, runs, gate, lock } = fixture();
    await control.start!([{ role: "API", ready: () => true }]);
    await control.beginShutdown!();
    await control.drain!();
    lock.close.mockClear();
    const acquire = vi.spyOn(gate, "acquire");
    acquire.mockRejectedValueOnce(Error("OPERATION_GATE_BUSY"));
    const clean = vi.spyOn(runs, "clean");
    const closed = control.resourcesClosed!(true);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(clean).not.toHaveBeenCalled();
    expect(lock.close).not.toHaveBeenCalled();
    await closed;
    expect(clean).toHaveBeenCalledOnce();
    expect(lock.close).toHaveBeenCalledTimes(2);
  });
  it("joins a stopping SQL callback before reporting the participant terminal", async () => {
    const { control, runs, repository } = fixture();
    let release!: () => void;
    vi.spyOn(runs, "stopping").mockImplementation(
      () => new Promise<void>((resolve) => (release = resolve)),
    );
    await control.start!([{ role: "METADATA", ready: () => true }]);
    const stopping = control.beginShutdown!();
    control.stop!();
    let drained = false;
    const drain = control.drain!().then(() => {
      drained = true;
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(drained).toBe(false);
    expect(
      repository.runtimeBeat.mock.calls.some(
        (call) => call[2].reasonCode === "STOPPED",
      ),
    ).toBe(false);
    release();
    await stopping;
    await drain;
    expect(repository.runtimeBeat).toHaveBeenLastCalledWith(
      "METADATA",
      expect.any(String),
      expect.objectContaining({ state: "STOPPED" }),
    );
  });
  it("drains a rejected queued READY heartbeat only after the exact run is authoritatively STOPPING", async () => {
    const { control, runs, repository } = fixture();
    vi.spyOn(runs, "ready")
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new SystemControlError("CONTROL_UNAVAILABLE"));
    vi.spyOn(runs, "phase")
      .mockResolvedValueOnce("ACTIVE")
      .mockResolvedValueOnce("ACTIVE")
      .mockResolvedValueOnce("RECOVERY_REQUIRED")
      .mockResolvedValueOnce("STOPPING");
    const stopped = vi.fn(() => control.stop!());
    control.onStopping!(stopped);
    await control.start!([{ role: "METADATA", ready: () => true }]);
    expect(stopped).toHaveBeenCalledTimes(1);
    expect(repository.latch).not.toHaveBeenCalled();
    await expect(
      control.admission.run("MEDIA_WRITE", async () => "never-started"),
    ).rejects.toThrow("WRITE_PAUSED");
    control.stop!();
    await control.drain!();
  });
  it("retains protection when a queued READY rejects while its exact run remains ACTIVE", async () => {
    const { control, runs, repository } = fixture();
    vi.spyOn(runs, "ready")
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new SystemControlError("CONTROL_UNAVAILABLE"));
    vi.spyOn(runs, "phase")
      .mockResolvedValueOnce("ACTIVE")
      .mockResolvedValueOnce("ACTIVE")
      .mockResolvedValueOnce("RECOVERY_REQUIRED")
      .mockResolvedValueOnce("ACTIVE");
    const stopped = vi.fn();
    control.onStopping!(stopped);
    await control.start!([{ role: "METADATA", ready: () => true }]);
    expect(stopped).not.toHaveBeenCalled();
    expect(repository.latch).toHaveBeenCalledWith(
      "DB_UNAVAILABLE",
      expect.any(String),
    );
    await expect(
      control.admission.run("MEDIA_WRITE", async () => "never-started"),
    ).rejects.toThrow("WRITE_PAUSED");
    control.stop!();
    await control.drain!();
  });
  it("a healthy metadata boot observes shared startup protection without inventing a local fault, while real local faults remain denied", async () => {
    const { current, repository, runtime, control, clearSharedMarker } =
      fixture();
    control.bindHealth!(async () => {});
    await control.start!([{ role: "METADATA", ready: () => true }]);
    await runtime.syncStartupMarker("STORAGE_UNAVAILABLE");
    expect(repository.latch).toHaveBeenCalledWith(
      "STORAGE_UNAVAILABLE",
      expect.any(String),
    );
    expect(control.locallyDenied()).toBe(false);
    current.faultLatched = true;
    await expect(
      control.admission.run("MEDIA_WRITE", async () => "not-started"),
    ).rejects.toThrow("WRITE_PAUSED");
    current.faultLatched = false;
    expect(
      await control.admission.run(
        "MEDIA_WRITE",
        async () => "healthy-participant",
      ),
    ).toBe("healthy-participant");
    await control.trip!("STORAGE_UNAVAILABLE");
    clearSharedMarker();
    expect(control.locallyDenied()).toBe(true);
    await expect(
      control.admission.run("MEDIA_WRITE", async () => "not-started"),
    ).rejects.toThrow("WRITE_PAUSED");
    control.stop!();
    await control.drain!();
  });
  it("logs only fixed categories when a health probe rejects with private driver details", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const { control } = fixture();
    control.bindHealth!(async () => {
      throw new Error("synthetic-private-driver-detail");
    });
    await control.start!([{ role: "API", ready: () => true }]);
    control.stop!();
    await control.drain!();
    expect(logged.mock.calls).toEqual([
      [
        JSON.stringify({
          event: "storage_health_unavailable",
          category: "UNCLASSIFIED",
        }),
      ],
    ]);
    expect(JSON.stringify(logged.mock.calls)).not.toContain(
      "synthetic-private-driver-detail",
    );
  });
  it("includes configured never-started critical roles without dropping the local owner", () => {
    expect(
      configuredControlRoles(["API", "DERIVATIVE"], "API,METADATA,PURGE"),
    ).toEqual(["API", "DERIVATIVE", "METADATA", "PURGE"]);
    expect(configuredControlRoles(["PURGE"], "API")).toEqual(["PURGE", "API"]);
    expect(() => configuredControlRoles(["API"], "API,API")).toThrow(
      "CONTROL_PARTICIPANT_CONFIG_INVALID",
    );
    expect(() => configuredControlRoles(["API"], "API,UNKNOWN")).toThrow(
      "CONTROL_PARTICIPANT_CONFIG_INVALID",
    );
  });
  it("rejects duplicate boot registrations before any database mutation", async () => {
    const { control, repository } = fixture();
    await expect(
      control.start!([
        { role: "API", ready: () => true },
        { role: "API", ready: () => true },
      ]),
    ).rejects.toThrow("CONTROL_PARTICIPANT_CONFIG_INVALID");
    expect(repository.runtimeRegister).not.toHaveBeenCalled();
  });
  it("records an exact boot, reports healthy idle, and does not invent completed work", async () => {
    const { control, repository } = fixture();
    control.bindHealth!(async () => {});
    await control.start!([{ role: "API", ready: () => true }]);
    control.stop!();
    const boot = repository.runtimeBeat.mock.calls[0]![1];
    expect(boot).toMatch(/^[0-9a-f-]{36}$/);
    expect(repository.runtimeBeat).toHaveBeenCalledWith(
      "API",
      boot,
      expect.objectContaining({
        state: "IDLE",
        reasonCode: "IDLE",
        success: false,
        completedUnits: "0",
      }),
    );
    await control.drain!();
    expect(repository.runtimeBeat).toHaveBeenLastCalledWith(
      "API",
      boot,
      expect.objectContaining({ state: "STOPPED", completedUnits: "0" }),
    );
  });
  it("tracks actual running callbacks and settled successful units, excluding idle and rejected work", async () => {
    vi.useFakeTimers();
    const { control, repository } = fixture();
    control.bindHealth!(async () => {});
    await control.start!([{ role: "METADATA", ready: () => true }]);
    let release!: (v: boolean) => void;
    const unit = control.track!(
      "METADATA",
      () =>
        new Promise<boolean>((r) => {
          release = r;
        }),
    );
    await vi.advanceTimersByTimeAsync(5000);
    expect(repository.runtimeBeat).toHaveBeenLastCalledWith(
      "METADATA",
      expect.any(String),
      expect.objectContaining({
        state: "RUNNING",
        reasonCode: "NONE",
        completedUnits: "0",
      }),
    );
    release(true);
    await unit;
    await control.track!("METADATA", async () => false);
    await expect(
      control.track!("METADATA", async () => {
        throw Error("BAD_JOB");
      }),
    ).rejects.toThrow("BAD_JOB");
    await vi.advanceTimersByTimeAsync(5000);
    expect(repository.runtimeBeat).toHaveBeenLastCalledWith(
      "METADATA",
      expect.any(String),
      expect.objectContaining({
        state: "IDLE",
        success: true,
        completedUnits: "1",
      }),
    );
    await vi.advanceTimersByTimeAsync(5000);
    expect(repository.runtimeBeat).toHaveBeenLastCalledWith(
      "METADATA",
      expect.any(String),
      expect.objectContaining({ success: false, completedUnits: "1" }),
    );
    await control.drain!();
  });
  it("enforces the fresh readonly probe before business work and durably latches its failure", async () => {
    const { control, repository, readMarker } = fixture();
    const operation = vi.fn(async () => "written"),
      probe = vi.fn(async () => {
        throw Error("OWNER_CHANGED");
      });
    await control.start!([{ role: "API", ready: () => true }]);
    control.stop!();
    control.bindHealth!(probe);
    await expect(
      control.admission.run("MEDIA_WRITE", operation),
    ).rejects.toThrow("CONTROL_UNAVAILABLE");
    expect(operation).not.toHaveBeenCalled();
    expect(control.locallyDenied()).toBe(true);
    expect(readMarker()?.reasonCode).toBe("STORAGE_UNAVAILABLE");
    expect(repository.latch).toHaveBeenCalledOnce();
    await expect(
      control.admission.run("MEDIA_WRITE", operation),
    ).rejects.toThrow("WRITE_PAUSED");
    expect(probe).toHaveBeenCalledTimes(1);
  });
  it("a missing probe cannot grant media admission, and named revoke stays available", async () => {
    const { control } = fixture();
    await control.start!([{ role: "API", ready: () => true }]);
    control.stop!();
    await expect(
      control.admission.run("MEDIA_WRITE", async () => {}),
    ).rejects.toThrow("CONTROL_UNAVAILABLE");
    expect(
      await control.admission.run("MEMBER_REVOKE", async () => "revoked"),
    ).toBe("revoked");
  });
  it("a new incarnation superseding the boot trips protection and the old exit cannot update it", async () => {
    const { control, repository } = fixture();
    repository.runtimeBeat.mockResolvedValue(false);
    control.bindHealth!(async () => {});
    await control.start!([{ role: "API", ready: () => true }]);
    control.stop!();
    expect(control.locallyDenied()).toBe(true);
    expect(repository.latch).toHaveBeenCalledWith(
      "WRITER_NOT_READY",
      expect.any(String),
    );
    const beats = repository.runtimeBeat.mock.calls.length;
    await control.drain!();
    expect(repository.runtimeBeat).toHaveBeenCalledTimes(beats);
  });
  it("a poison COMMIT classification latches and rethrows without replaying business work", async () => {
    const { control, repository } = fixture();
    await control.start!([{ role: "API", ready: () => true }]);
    control.stop!();
    control.bindHealth!(async () => {});
    const unknown = new Error("opaque");
    unknown.name = "CommitOutcomeUnknownError";
    const operation = vi.fn(async () => {
      throw unknown;
    });
    await expect(control.admission.run("MEDIA_WRITE", operation)).rejects.toBe(
      unknown,
    );
    expect(repository.latch).toHaveBeenCalledWith(
      "COMMIT_UNKNOWN",
      expect.any(String),
    );
    await expect(
      control.admission.run("MEDIA_WRITE", operation),
    ).rejects.toThrow("WRITE_PAUSED");
    expect(operation).toHaveBeenCalledOnce();
  });
});
