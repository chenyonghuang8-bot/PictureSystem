import { AsyncLocalStorage } from "node:async_hooks";
import { createRequire } from "node:module";
import { dirname, isAbsolute, join, normalize } from "node:path";
import { performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";

const require = createRequire(import.meta.url);
type Handle = object;
export type DurableDeny = Readonly<{ token: string; reasonCode: string }>;
export type RunOwnerIdentity = Readonly<{
  processId: string;
  osBootId: string;
  pid: number;
  startSec: string;
  startUsec: number;
}>;
type Binding = {
  registerOperationRunOwner(
    handle: Handle,
    processId: string,
  ): Omit<RunOwnerIdentity, "processId">;
  verifyOperationRunOwner(
    handle: Handle,
    processId: string,
    boot: string,
    pid: number,
    sec: string,
    usec: number,
  ): boolean;
  bridgeRegisteredLaunch(gate: Handle, launch: Handle): void;
  openOperationGate(
    path: string,
    deployment: string,
    kind: "G" | "L" | "R",
    provision: boolean,
  ): Handle;
  tryOperationGate(handle: Handle, mode: "S" | "X"): boolean;
  closeOperationGate(handle: Handle): void;
  recoverOperationBridges(handle: Handle): void;
  operationGateIdentity(handle: Handle): string;
  readOperationDeny(handle: Handle): DurableDeny | null;
  latchOperationDeny(handle: Handle, reason: string): DurableDeny;
  clearOperationDeny(exclusive: Handle, latch: Handle, token: string): void;
};
function native(): Binding {
  const entry = require.resolve("@family-album/storage");
  return require(
    join(dirname(entry), "../build/storage_native.node"),
  ) as Binding;
}
export type ControlNamespace = Readonly<{ path: string; deploymentId: string }>;

const activePermit = new AsyncLocalStorage<OperationLock>();

/** Dedicated deployment lock namespace; never a media/content coordination key. */
export class OperationGate {
  constructor(readonly namespace: ControlNamespace) {
    if (
      !isAbsolute(namespace.path) ||
      normalize(namespace.path) !== namespace.path ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(
        namespace.deploymentId,
      )
    )
      throw new Error("OPERATION_GATE_INVALID");
    this.namespace = Object.freeze({ ...namespace });
  }

  /** Explicit DEV bootstrap only. Normal request acquisition never creates files. */
  static provisionDev(namespace: ControlNamespace) {
    const gate = new OperationGate(namespace);
    const binding = native();
    for (const kind of ["G", "L", "R"] as const) {
      const handle = binding.openOperationGate(
        namespace.path,
        namespace.deploymentId,
        kind,
        true,
      );
      binding.closeOperationGate(handle);
    }
    return gate;
  }

  async acquire(
    mode: "S" | "X",
    timeoutMs = 30_000,
    signal?: AbortSignal,
  ): Promise<OperationLock> {
    return this.acquireKind("G", mode, timeoutMs, signal);
  }
  async acquireRun() {
    return this.acquireKind("R", "X", 0);
  }
  runIdentity() {
    const b = native(),
      h = b.openOperationGate(
        this.namespace.path,
        this.namespace.deploymentId,
        "R",
        false,
      );
    try {
      return b.operationGateIdentity(h);
    } finally {
      b.closeOperationGate(h);
    }
  }
  verifyRunOwner(owner: RunOwnerIdentity) {
    const b = native(),
      h = b.openOperationGate(
        this.namespace.path,
        this.namespace.deploymentId,
        "R",
        false,
      );
    try {
      return b.verifyOperationRunOwner(
        h,
        owner.processId,
        owner.osBootId,
        owner.pid,
        owner.startSec,
        owner.startUsec,
      );
    } finally {
      b.closeOperationGate(h);
    }
  }
  async acquireLatch(timeoutMs = 2_000, signal?: AbortSignal) {
    return this.acquireKind("L", "X", timeoutMs, signal);
  }
  private async acquireKind(
    kind: "G" | "L" | "R",
    mode: "S" | "X",
    timeoutMs: number,
    signal?: AbortSignal,
  ) {
    if (!Number.isFinite(timeoutMs) || timeoutMs < 0 || timeoutMs > 30_000)
      throw new Error("OPERATION_GATE_INVALID_TIMEOUT");
    const binding = native();
    const handle = binding.openOperationGate(
      this.namespace.path,
      this.namespace.deploymentId,
      kind,
      false,
    );
    const deadline = performance.now() + timeoutMs;
    try {
      while (true) {
        signal?.throwIfAborted();
        if (binding.tryOperationGate(handle, mode))
          return new OperationLock(binding, handle, mode, kind);
        if (performance.now() >= deadline)
          throw new Error("OPERATION_GATE_BUSY");
        await delay(5, undefined, signal ? { signal } : undefined);
      }
    } catch (error) {
      try {
        binding.closeOperationGate(handle);
      } catch {
        // Native drain rejection already discards its private RAW_X descriptor.
      }
      throw error;
    }
  }
}

/** Internal lifetime token for the actual admitted operation unit. */
export class OperationLock {
  #closed = false;
  constructor(
    private readonly binding: Binding,
    private readonly handle: Handle,
    readonly mode: "S" | "X",
    private readonly kind: "G" | "L" | "R",
  ) {}
  get drained() {
    return !this.#closed && this.kind === "G" && this.mode === "X";
  }
  registerRunOwner(processId: string): RunOwnerIdentity {
    if (this.#closed || this.kind !== "R" || this.mode !== "X")
      throw Error("OPERATION_RUN_REQUIRED");
    return {
      ...this.binding.registerOperationRunOwner(this.handle, processId),
      processId,
    };
  }
  bridgeLaunch(launch: object) {
    if (this.#closed || this.mode !== "S")
      throw new Error("OPERATION_SHARED_PERMIT_REQUIRED");
    this.binding.bridgeRegisteredLaunch(this.handle, launch);
  }
  withNativeAdmission<T>(run: (handle: Handle) => T): T {
    if (this.#closed || this.mode !== "S")
      throw new Error("OPERATION_SHARED_PERMIT_REQUIRED");
    return run(this.handle);
  }
  recoverBridges() {
    if (this.#closed || !this.drained)
      throw new Error("OPERATION_RECOVERY_REQUIRED");
    this.binding.recoverOperationBridges(this.handle);
  }
  identity() {
    if (this.#closed) throw new Error("OPERATION_GATE_CLOSED");
    return this.binding.operationGateIdentity(this.handle);
  }
  readDeny() {
    if (this.#closed) throw new Error("OPERATION_GATE_CLOSED");
    return this.binding.readOperationDeny(this.handle);
  }
  latchDeny(reason: string) {
    if (this.#closed || !/^[A-Z_]{1,48}$/u.test(reason))
      throw new Error("OPERATION_LATCH_REQUIRED");
    return this.binding.latchOperationDeny(this.handle, reason);
  }
  clearDenyWith(latch: OperationLock, token: string) {
    if (this.#closed || latch.#closed) throw new Error("OPERATION_GATE_CLOSED");
    this.binding.clearOperationDeny(this.handle, latch.handle, token);
  }
  async run<T>(operation: () => Promise<T>) {
    if (this.#closed) throw new Error("OPERATION_GATE_CLOSED");
    return activePermit.run(this, operation);
  }
  close() {
    if (this.#closed) return;
    this.#closed = true;
    this.binding.closeOperationGate(this.handle);
  }
}

/** Internal dispatch only. No numeric file descriptor is exposed or inherited. */
export function currentOperationPermit() {
  return activePermit.getStore();
}
